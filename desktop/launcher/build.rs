// Gives the launcher the program icon and Windows version info, so Explorer,
// the taskbar and Task Manager show "SD Image Sorter" with its icon.
fn main() {
    println!("cargo:rerun-if-changed=../build/icon.ico");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut res = winresource::WindowsResource::new();
    res.set_icon("../build/icon.ico");
    res.set("ProductName", "SD Image Sorter");
    res.set("FileDescription", "SD Image Sorter");
    res.set("InternalName", "SD Image Sorter");
    res.set("OriginalFilename", "SD Image Sorter.exe");
    res.set("CompanyName", "Rinne414");
    res.set("LegalCopyright", "MIT License");
    res.compile().expect("could not embed the icon and version info");
}
