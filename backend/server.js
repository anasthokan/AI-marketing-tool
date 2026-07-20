import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import generateRoute from "./routes/generate.js";
import { startScheduler } from "./scheduler/postScheduler.js";
import { resolveIgBrowserLaunch } from "./utils/igBrowser.js";

dotenv.config();

try {
  const ig = resolveIgBrowserLaunch();
  console.log(
    `Instagram will use: ${ig.label}${ig.executablePath ? ` @ ${ig.executablePath}` : ""}`
  );
} catch (err) {
  console.log("Instagram browser setup:", err.message);
}

const app = express();
app.use(cors());
app.use(express.json());
startScheduler();

// MongoDB connect (retry so late mongod start still works)
const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ai-marketing";
mongoose
  .connect(mongoUri)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("MongoDB initial connect failed:", err.message));

mongoose.connection.on("disconnected", () => {
  console.log("MongoDB disconnected");
});
mongoose.connection.on("reconnected", () => {
  console.log("MongoDB reconnected");
});

app.use("/api", generateRoute);

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on 0.0.0.0:${PORT}`)
);