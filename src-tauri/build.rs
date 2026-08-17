fn main() {
    // tauri.conf.json takes its version from ../package.json, but tauri_build
    // only watches the conf file - so a version bump alone left the previous
    // build's version resource baked into the exe.
    println!("cargo:rerun-if-changed=../package.json");
    tauri_build::build()
}
