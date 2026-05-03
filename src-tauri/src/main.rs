// Yunomia - Tauri shell entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yunomia_lib::run()
}
