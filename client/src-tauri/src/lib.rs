use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

// Sample command kept from the create-tauri-app scaffold so any
// legacy front-end calls don't break the build. Not currently used.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // updater + process are required for the in-app auto-update
        // banner: updater fetches + verifies the Ed25519-signed
        // manifest, process exposes `relaunch()` so the JS side can
        // restart the app after a successful install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // ----- System tray -------------------------------------
            //
            // Right-click menu: "Show OreoHouse" + "Quit". Left-click
            // toggles the main window between visible+focused and
            // hidden, MSN-style.

            let show_item = MenuItem::with_id(
                app,
                "show",
                "Show OreoHouse",
                true,
                None::<&str>,
            )?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "Quit",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_item, &sep, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("oreohouse-tray")
                .tooltip("OreoHouse")
                .menu(&menu)
                // Right-click → menu; left-click is handled below.
                .show_menu_on_left_click(false)
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "show" => show_main_window(app_handle),
                    "quit" => app_handle.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                });

            // Default window icon is whatever bundle.icon picks for
            // the platform — usable as the tray icon too.
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _tray = tray_builder.build(app)?;

            Ok(())
        })
        // ----- Close-to-tray ---------------------------------------
        //
        // Clicking the [X] on the MAIN window hides it instead of
        // exiting the process. Quit is only reachable through the
        // tray's "Quit" item, so the app keeps running and receiving
        // WS messages in the background.
        //
        // Chat sub-windows (label `chat-{id}`) are real children — let
        // their [X] close them normally so the conversation can drop
        // out of view without taking the app down.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let visible = win.is_visible().unwrap_or(false);
    let focused = win.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
