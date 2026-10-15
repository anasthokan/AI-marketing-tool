import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import generateRoute from "./routes/generate.js";
import { startScheduler } from "./scheduler/postScheduler.js";
import { resolveIgBrowserLaunch } from "./utils/igBrowser.js";
import { getUploadsRoot } from "./utils/paths.js";

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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
startScheduler();

const mongoUri =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ai-marketing";
let mongoRetryTimer = null;

const connectMongo = async () => {
  if (mongoose.connection.readyState === 1) return;
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.log("MongoDB Connected");
  } catch (err) {
    console.log("MongoDB connect failed, retrying in 5s:", err.message);
    if (!mongoRetryTimer) {
      mongoRetryTimer = setTimeout(() => {
        mongoRetryTimer = null;
        connectMongo();
      }, 5000);
    }
  }
};

connectMongo();

mongoose.connection.on("disconnected", () => {
  console.log("MongoDB disconnected — retrying");
  if (!mongoRetryTimer) {
    mongoRetryTimer = setTimeout(() => {
      mongoRetryTimer = null;
      connectMongo();
    }, 5000);
  }
});
mongoose.connection.on("reconnected", () => {
  console.log("MongoDB reconnected");
});

app.use("/api", generateRoute);
app.use("/uploads", express.static(getUploadsRoot()));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on 0.0.0.0:${PORT}`)
);