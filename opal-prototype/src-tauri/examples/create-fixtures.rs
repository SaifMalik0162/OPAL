use std::{collections::BTreeMap, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixtures = app_lib::generate_fixture_libraries().map_err(std::io::Error::other)?;
    let manifest_path = std::env::var_os("OPAL_FIXTURE_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src-tauri/target/opal-fixtures.json"));
    let manifest = fixtures
        .into_iter()
        .map(|(name, path)| (name, path.to_string_lossy().into_owned()))
        .collect::<BTreeMap<_, _>>();
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    println!("Fixture libraries created. Manifest: {}", manifest_path.display());
    Ok(())
}
