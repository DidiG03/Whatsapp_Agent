/**
 * Server bootstrap: creates the app and starts listening.
 */
import { createApp } from "./src/app.mjs";
import { PORT } from "./src/config.mjs";

const app = createApp();
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

