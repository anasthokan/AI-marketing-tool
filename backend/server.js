import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import generateRoute from "./routes/generate.js";
import { startScheduler } from "./scheduler/postScheduler.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
startScheduler();

// MongoDB connect
mongoose.connect(process.env.MONGO_URI)
  .then(()=>console.log("MongoDB Connected"))
  .catch(err=>console.log(err));

app.use("/api", generateRoute);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));