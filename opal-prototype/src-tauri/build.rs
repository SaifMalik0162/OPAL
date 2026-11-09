fn main() {
    println!("cargo:rerun-if-env-changed=OPAL_BUILD_COMMIT");
    let commit = std::env::var("OPAL_BUILD_COMMIT").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=OPAL_BUILD_COMMIT={commit}");
    tauri_build::build()
}
