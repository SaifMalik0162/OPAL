use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, ImageDecoder, ImageFormat, ImageReader, Limits,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MAX_INPUT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_DIMENSION: u32 = 8_192;
const MAX_PIXELS: u64 = 32_000_000;
const MAX_DECODE_BYTES: u64 = 160 * 1024 * 1024;
const MAX_OUTPUT_EDGE: u32 = 2_560;
const FALLBACK_ACCENT: &str = "#C3BBEF";
const ALLOWED_EXTENSIONS: [&str; 3] = ["jpg", "png", "webp"];

static APPEARANCE_ASSET_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceAsset {
    asset_id: String,
    path: String,
    suggested_accent: String,
}

fn validate_asset_id(value: &str) -> Result<String, String> {
    let parsed = Uuid::parse_str(value)
        .map_err(|_| "That background image reference is invalid.".to_string())?;
    let canonical = parsed.hyphenated().to_string();
    if canonical != value {
        return Err("That background image reference is invalid.".to_string());
    }
    Ok(canonical)
}

fn regular_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Could not prepare background storage: {error}"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect background storage: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("OPAL background storage must be a regular folder.".to_string());
    }
    Ok(())
}

fn backgrounds_directory(app_data_dir: &Path, create: bool) -> Result<PathBuf, String> {
    if create {
        regular_directory(app_data_dir)?;
    }
    let appearance_dir = app_data_dir.join("appearance");
    let backgrounds_dir = appearance_dir.join("backgrounds");
    if create {
        regular_directory(&appearance_dir)?;
        regular_directory(&backgrounds_dir)?;
    } else if !backgrounds_dir.exists() {
        return Ok(backgrounds_dir);
    }
    for path in [&appearance_dir, &backgrounds_dir] {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Could not inspect background storage: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("OPAL background storage must be a regular folder.".to_string());
        }
    }
    Ok(backgrounds_dir)
}

fn source_image(path: &Path) -> Result<image::DynamicImage, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "OPAL could not read that background image.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Choose a regular image file for the background.".to_string());
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err("Background images must be 25 MB or smaller.".to_string());
    }
    let file = fs::File::open(path)
        .map_err(|_| "OPAL could not open that background image.".to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "OPAL could not read that background image.".to_string())?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("Background images must be 25 MB or smaller.".to_string());
    }
    if bytes.is_empty() {
        return Err("That image file is empty. Choose another image.".to_string());
    }

    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "OPAL could not identify that background image.".to_string())?;
    let format = reader
        .format()
        .ok_or_else(|| "Choose a PNG, JPG, JPEG, or WEBP image.".to_string())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("Backgrounds must be PNG, JPG, JPEG, or WEBP images.".to_string());
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "OPAL could not decode that background image.".to_string())?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("Background images must be 32 megapixels or smaller.".to_string());
    }
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| "OPAL could not decode that background image.".to_string())?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

fn sample_accent(image: &image::DynamicImage) -> String {
    let pixels = image.thumbnail(32, 32).to_rgba8();
    let mut buckets: HashMap<(u8, u8, u8), (u32, u32, u32, u32)> = HashMap::new();
    for pixel in pixels.pixels() {
        let [red, green, blue, alpha] = pixel.0;
        if alpha < 160 {
            continue;
        }
        let maximum = red.max(green).max(blue);
        let minimum = red.min(green).min(blue);
        let brightness = f32::from(maximum) / 255.0;
        let saturation = if maximum == 0 {
            0.0
        } else {
            f32::from(maximum - minimum) / f32::from(maximum)
        };
        if brightness < 0.1 || saturation < 0.18 {
            continue;
        }

        let key = (red >> 4, green >> 4, blue >> 4);
        let bucket = buckets.entry(key).or_default();
        bucket.0 += u32::from(red);
        bucket.1 += u32::from(green);
        bucket.2 += u32::from(blue);
        bucket.3 += 1;
    }

    let Some((_, (red, green, blue, count))) = buckets
        .into_iter()
        .max_by_key(|(key, bucket)| (bucket.3, *key))
    else {
        return FALLBACK_ACCENT.to_string();
    };
    format!(
        "#{:02X}{:02X}{:02X}",
        red / count,
        green / count,
        blue / count
    )
}

fn encode_background(
    image: &image::DynamicImage,
    path: &Path,
    format: ImageFormat,
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not stage the background image: {error}"))?;
    if format == ImageFormat::Jpeg {
        let mut encoder = JpegEncoder::new_with_quality(&mut file, 88);
        encoder
            .encode_image(image)
            .map_err(|error| format!("Could not save the background image: {error}"))?;
    } else {
        image
            .write_to(&mut file, format)
            .map_err(|error| format!("Could not save the background image: {error}"))?;
    }
    file.flush()
        .map_err(|error| format!("Could not finish saving the background image: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not finish saving the background image: {error}"))?;
    Ok(())
}

fn import_image(app_data_dir: &Path, source_path: &Path) -> Result<AppearanceAsset, String> {
    let _guard = APPEARANCE_ASSET_LOCK
        .lock()
        .map_err(|_| "Background image storage is unavailable.".to_string())?;
    let decoded = source_image(source_path)?;
    let suggested_accent = sample_accent(&decoded);
    let output_format = if decoded.has_alpha() {
        ImageFormat::Png
    } else {
        ImageFormat::Jpeg
    };
    let extension = if output_format == ImageFormat::Png {
        "png"
    } else {
        "jpg"
    };
    let resized = decoded.resize(MAX_OUTPUT_EDGE, MAX_OUTPUT_EDGE, FilterType::Lanczos3);
    let directory = backgrounds_directory(app_data_dir, true)?;
    let asset_id = Uuid::new_v4().hyphenated().to_string();
    let temporary_path = directory.join(format!(".pending-{asset_id}.{extension}"));
    let final_path = directory.join(format!("{asset_id}.{extension}"));

    if let Err(error) = encode_background(&resized, &temporary_path, output_format) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary_path, &final_path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Could not finish saving the background image: {error}"
        ));
    }

    Ok(AppearanceAsset {
        asset_id,
        path: final_path.to_string_lossy().into_owned(),
        suggested_accent,
    })
}

fn managed_asset_path(directory: &Path, asset_id: &str) -> Result<Option<PathBuf>, String> {
    let asset_id = validate_asset_id(asset_id)?;
    let directory = backgrounds_directory(directory, false)?;
    if !directory.exists() {
        return Ok(None);
    }
    for extension in ALLOWED_EXTENSIONS {
        let path = directory.join(format!("{asset_id}.{extension}"));
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("The managed background image is not a regular file.".to_string());
            }
            Ok(_) => return Ok(Some(path)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not inspect the managed background image: {error}"
                ))
            }
        }
    }
    Ok(None)
}

fn remove_managed_image(directory: &Path, asset_id: &str) -> Result<(), String> {
    let Some(path) = managed_asset_path(directory, asset_id)? else {
        return Ok(());
    };
    fs::remove_file(path)
        .map_err(|error| format!("Could not remove the managed background image: {error}"))
}

fn is_generated_image_name(name: &str) -> Option<String> {
    let (stem, extension) = name.rsplit_once('.')?;
    if !ALLOWED_EXTENSIONS.contains(&extension) {
        return None;
    }
    let asset_id = validate_asset_id(stem).ok()?;
    Some(asset_id)
}

fn is_generated_staging_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix(".pending-") else {
        return false;
    };
    is_generated_image_name(name).is_some()
}

fn reconcile_images(directory: &Path, protected_ids: &[String]) -> Result<(), String> {
    let directory = backgrounds_directory(directory, false)?;
    if !directory.exists() {
        return Ok(());
    }
    let protected = protected_ids
        .iter()
        .filter_map(|id| validate_asset_id(id).ok())
        .collect::<HashSet<_>>();
    let entries = fs::read_dir(&directory)
        .map_err(|error| format!("Could not inspect background images: {error}"))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("Could not inspect a background image: {error}"))?
            .path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let kind = fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect a background image: {error}"))?;
        if kind.file_type().is_symlink() || !kind.is_file() {
            continue;
        }
        if is_generated_staging_name(name) {
            fs::remove_file(&path).map_err(|error| {
                format!("Could not clear an interrupted background import: {error}")
            })?;
            continue;
        }
        if let Some(id) = is_generated_image_name(name) {
            if !protected.contains(&id) {
                fs::remove_file(&path).map_err(|error| {
                    format!("Could not clear an unused background image: {error}")
                })?;
            }
        }
    }
    Ok(())
}

#[tauri::command(rename = "importAppearanceBackground", rename_all = "camelCase")]
pub async fn import_appearance_background(
    app: AppHandle,
    source_path: String,
) -> Result<AppearanceAsset, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate OPAL storage: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        import_image(&app_data_dir, Path::new(&source_path))
    })
    .await
    .map_err(|error| format!("Background image import did not finish: {error}"))?
}

#[tauri::command(rename = "resolveAppearanceBackground", rename_all = "camelCase")]
pub fn resolve_appearance_background(
    app: AppHandle,
    asset_id: String,
) -> Result<Option<String>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate OPAL storage: {error}"))?;
    let _guard = APPEARANCE_ASSET_LOCK
        .lock()
        .map_err(|_| "Background image storage is unavailable.".to_string())?;
    Ok(managed_asset_path(&app_data_dir, &asset_id)?
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command(rename = "removeAppearanceBackground", rename_all = "camelCase")]
pub async fn remove_appearance_background(app: AppHandle, asset_id: String) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate OPAL storage: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = APPEARANCE_ASSET_LOCK
            .lock()
            .map_err(|_| "Background image storage is unavailable.".to_string())?;
        remove_managed_image(&app_data_dir, &asset_id)
    })
    .await
    .map_err(|error| format!("Background image cleanup did not finish: {error}"))?
}

#[tauri::command(rename = "reconcileAppearanceBackgrounds", rename_all = "camelCase")]
pub async fn reconcile_appearance_backgrounds(
    app: AppHandle,
    protected_asset_ids: Vec<String>,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate OPAL storage: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = APPEARANCE_ASSET_LOCK
            .lock()
            .map_err(|_| "Background image storage is unavailable.".to_string())?;
        reconcile_images(&app_data_dir, &protected_asset_ids)
    })
    .await
    .map_err(|error| format!("Background image cleanup did not finish: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgba, RgbaImage};
    use tempfile::tempdir;

    fn write_test_image(path: &Path, color: Rgba<u8>, width: u32, height: u32) {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, color));
        image
            .save_with_format(path, ImageFormat::Png)
            .expect("test image should save");
    }

    #[test]
    fn imports_scaled_managed_png_and_samples_accent() {
        let temp = tempdir().expect("temporary folder");
        let source = temp.path().join("source.png");
        write_test_image(&source, Rgba([140, 50, 185, 255]), 3000, 1800);

        let asset = import_image(temp.path(), &source).expect("image should import");
        assert_eq!(asset.suggested_accent, "#8C32B9");
        assert!(asset.path.ends_with(".png"));
        let decoded = image::open(&asset.path).expect("managed image should decode");
        assert_eq!(decoded.width(), MAX_OUTPUT_EDGE);
        assert!(decoded.height() <= MAX_OUTPUT_EDGE);
        assert!(managed_asset_path(temp.path(), &asset.asset_id)
            .expect("asset resolves")
            .is_some());
    }

    #[test]
    fn accepts_supported_images_by_decoded_format_not_filename_extension() {
        let temp = tempdir().expect("temporary folder");
        let source = temp.path().join("valid-image.data");
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            80,
            60,
            image::Rgb([42, 89, 173]),
        ));
        image
            .write_to(
                &mut fs::File::create(&source).expect("source should open"),
                ImageFormat::Jpeg,
            )
            .expect("jpeg should encode");

        let imported = import_image(temp.path(), &source).expect("decoded jpeg should import");
        assert!(imported.path.ends_with(".jpg"));
    }

    #[test]
    fn rejects_over_limit_dimensions_and_input_size() {
        let temp = tempdir().expect("temporary folder");
        let oversized_dimensions = temp.path().join("wide.png");
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            MAX_DIMENSION + 1,
            1,
            Rgba([1, 2, 3, 255]),
        ))
        .save_with_format(&oversized_dimensions, ImageFormat::Png)
        .expect("test image should save");
        assert!(
            source_image(&oversized_dimensions).is_err(),
            "image width limit should be enforced"
        );

        let oversized_file = temp.path().join("oversized.jpg");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&oversized_file)
            .expect("file should open");
        file.set_len(MAX_INPUT_BYTES + 1)
            .expect("file size should increase");
        assert!(source_image(&oversized_file).unwrap_err().contains("25 MB"));
    }

    #[test]
    fn invalid_and_noncanonical_asset_ids_are_rejected() {
        let temp = tempdir().expect("temporary folder");
        assert!(managed_asset_path(temp.path(), "../../outside").is_err());
        assert!(managed_asset_path(temp.path(), "AABBCCDD-0000-4000-8000-000000000000").is_err());
    }

    #[test]
    fn cleanup_removes_only_unreferenced_generated_files() {
        let temp = tempdir().expect("temporary folder");
        let directory = temp.path().join("appearance").join("backgrounds");
        regular_directory(&directory).expect("folder should be created");
        let kept = "11111111-1111-4111-8111-111111111111";
        let removed = "22222222-2222-4222-8222-222222222222";
        let unrelated = directory.join("readme.txt");
        fs::write(directory.join(format!("{kept}.jpg")), b"kept").expect("file should write");
        fs::write(directory.join(format!("{removed}.png")), b"removed").expect("file should write");
        fs::write(
            directory.join(".pending-33333333-3333-4333-8333-333333333333.jpg"),
            b"staged",
        )
        .expect("file should write");
        fs::write(&unrelated, b"untouched").expect("file should write");

        reconcile_images(temp.path(), &[kept.to_string()]).expect("reconciliation should succeed");

        assert!(directory.join(format!("{kept}.jpg")).exists());
        assert!(!directory.join(format!("{removed}.png")).exists());
        assert!(!directory
            .join(".pending-33333333-3333-4333-8333-333333333333.jpg")
            .exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn transparent_images_keep_alpha_and_neutral_images_use_fallback() {
        let temp = tempdir().expect("temporary folder");
        let source = temp.path().join("transparent.png");
        write_test_image(&source, Rgba([120, 50, 180, 80]), 800, 600);
        let imported = import_image(temp.path(), &source).expect("transparent image should import");
        assert!(imported.path.ends_with(".png"));
        assert_eq!(
            image::open(&imported.path)
                .expect("png should decode")
                .color(),
            image::ColorType::Rgba8
        );
        assert_eq!(imported.suggested_accent, FALLBACK_ACCENT);
    }
}
