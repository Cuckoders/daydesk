export async function notify(title: string, body: string) {
  try {
    const notifications = await import("@tauri-apps/plugin-notification");
    let granted = await notifications.isPermissionGranted();
    if (!granted) {
      granted = (await notifications.requestPermission()) === "granted";
    }
    if (granted) notifications.sendNotification({ title, body });
  } catch {
    if ("Notification" in window) {
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission === "granted") new Notification(title, { body });
    }
  }
}
