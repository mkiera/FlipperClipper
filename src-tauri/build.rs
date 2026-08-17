fn main() {
    // tauri_build only watches tauri.conf.json, which takes its version from ../package.json,
    // so a version bump alone left the previous build's version resource in the exe.
    println!("cargo:rerun-if-changed=../package.json");
    tauri_build::build()
}
