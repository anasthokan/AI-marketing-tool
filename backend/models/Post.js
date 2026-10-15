import mongoose from "mongoose";

const postSchema = new mongoose.Schema({
  company: String,
  website: String,
  inquiryUrl: String,
  whatsapp: String,
  industry: String,
  audience: String,
  country: String,
  platform: [String],
  posts: [String],
  images: [String],
  videos: [String],
  source: { type: String, default: "ai" }, // "ai" | "manual" | "video"
  confirmed: { type: Boolean, default: true },
  scheduledTime: String, // "10:30"
  postsPerDay: { type: Number, default: 1 },
  lastPostedDate: { type: String, default: null },
  posted: { type: Boolean, default: false },
  lastPostOk: Boolean,
  lastPostError: String,
  lastPostAttemptAt: Date,
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Post", postSchema);
