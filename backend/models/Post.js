import mongoose from "mongoose";

const postSchema = new mongoose.Schema({
  company: String,
  website: String,
  industry: String,
  audience: String,
  country: String,
  platform: [String],
  posts: [String],
  images: [String],
  scheduledTime: String, // "10:30"
  postsPerDay: { type: Number, default: 1 },
  lastPostedDate: { type: String, default: null },
  posted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Post", postSchema);
