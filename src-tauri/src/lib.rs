// Yunomia — Tauri library entry. Spawns ptys, bridges them to the frontend
// over Tauri events. Frontend mounts an xterm.js per pty. Project-agnostic.

mod pty;
mod store;
mod tickets;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let registry = pty::PtyRegistry::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(registry)
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            store::models_get,
            store::models_set,
            store::enumerate_sessions,
            store::delete_session,
            store::agent_context_estimate,
            tickets::tickets_list,
            tickets::tickets_create,
            tickets::tickets_patch,
            tickets::tickets_transition,
            tickets::comments_list,
            tickets::comments_create,
            tickets::project_state_get,
            tickets::project_state_set,
            tickets::brief_get,
            tickets::brief_write,
            tickets::lessons_list,
            tickets::lessons_create,
            tickets::lessons_patch,
            tickets::lessons_delete,
            tickets::proposals_read,
            tickets::proposals_clear,
            tickets::schedules_list,
            tickets::schedules_set,
            tickets::schedules_clear,
            tickets::schedules_due_now,
            tickets::audit_list,
            tickets::inbox_append,
            tickets::inbox_list,
            tickets::inbox_mark_processed,
            tickets::inbox_mark_all,
            tickets::agent_file_get,
            tickets::agent_file_write,
            tickets::project_agents_list,
            tickets::project_agents_upsert,
            tickets::project_agents_remove,
            tickets::reports_summary,
            tickets::eligible_actions,
            tickets::kill_switch_get,
            tickets::kill_switch_set,
            tickets::agent_proposal_read,
            tickets::agent_proposal_clear,
            tickets::agent_proposal_approve,
        ])
        .setup(|app| {
            let _window = app.get_webview_window("main").expect("main window missing");
            store::start_sentinel_watcher(app.handle().clone());
            log::info!("Yunomia shell up");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                log::info!("Yunomia shell exiting");
            }
        });
}
