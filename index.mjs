/**
 * Server bootstrap: creates the app and starts listening.
 */
import { createApp } from "./src/app.mjs";
import { PORT } from "./src/config.mjs";
import { startNotificationsScheduler } from "./src/jobs/notifications.mjs";

const app = createApp();
const stop = startNotificationsScheduler();
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// Basic shutdown handling
function shutdown(){
  try{ if (typeof stop === 'function') stop(); }catch{}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

