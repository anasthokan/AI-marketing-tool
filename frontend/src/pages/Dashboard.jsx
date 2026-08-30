import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import axios from "axios";
import "bootstrap/dist/css/bootstrap.min.css";

const apiBase = () => {
  const configured = import.meta.env.VITE_API_URL;
  return (
    configured != null && String(configured).trim() !== ""
      ? String(configured)
      : import.meta.env.PROD
        ? ""
        : "http://localhost:5000"
  ).replace(/\/$/, "");
};

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });

const VIDEO_STAGES = [
  { id: "script", label: "Script" },
  { id: "voice", label: "Voice" },
  { id: "footage", label: "Footage" },
  { id: "render", label: "Render" },
  { id: "finish", label: "Done" },
];

const STAGE_RANGES = {
  script: [0, 12],
  voice: [12, 30],
  footage: [30, 75],
  render: [75, 95],
  finish: [95, 100],
};

const segmentFill = (stageId, progress, currentStage) => {
  const order = VIDEO_STAGES.map((s) => s.id);
  const idx = order.indexOf(stageId);
  const cur = order.indexOf(currentStage || "script");
  if (idx < 0) return 0;
  if (progress >= 100 || idx < cur) return 100;
  if (idx > cur) return 0;
  const [start, end] = STAGE_RANGES[stageId] || [0, 100];
  return Math.min(100, Math.max(0, ((Number(progress) - start) / Math.max(1, end - start)) * 100));
};

const tabFromPath = (pathname) => {
  const path = String(pathname || "/").replace(/\/$/, "") || "/";
  if (path === "/manual") return "manual";
  if (path === "/ai-video" || path === "/video") return "video";
  return "ai";
};

export default function Dashboard() {
  const location = useLocation();
  const activeTab = tabFromPath(location.pathname);

  const [form, setForm] = useState({
    company: "",
    industry: "",
    website: "",
    inquiryUrl: "",
    whatsapp: "",
    audience: "",
    country: "",
    platform: [],
    postsPerDay: 1,
    scheduledTime: "",
  });

  const [manualCaption, setManualCaption] = useState("");
  const [manualImages, setManualImages] = useState([]);

  const [videoTopic, setVideoTopic] = useState("");
  const [videoScript, setVideoScript] = useState("");
  const [videoLanguage, setVideoLanguage] = useState("en");
  const [videoVoice, setVideoVoice] = useState("en-in");
  const [videoAspect, setVideoAspect] = useState("9:16");
  const [videoDuration, setVideoDuration] = useState(15);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoDraft, setVideoDraft] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [videoProgress, setVideoProgress] = useState(null);

  const [text, setText] = useState("");
  const [images, setImages] = useState([]);
  const [cta, setCta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const buildCtaFromForm = () => {
    const website = form.website?.trim()
      ? form.website.match(/^https?:\/\//i)
        ? form.website.trim()
        : `https://${form.website.trim()}`
      : null;
    const inquiryRaw = (form.inquiryUrl || form.website || "").trim();
    const inquiry = inquiryRaw
      ? inquiryRaw.match(/^https?:\/\//i)
        ? inquiryRaw
        : `https://${inquiryRaw}`
      : website;
    const digits = String(form.whatsapp || "").replace(/\D/g, "");
    const whatsapp = digits ? `https://wa.me/${digits}` : null;
    return { website, inquiry, whatsapp };
  };

  const handlePlatformChange = (value) => {
    if (form.platform.includes(value)) {
      setForm({
        ...form,
        platform: form.platform.filter((p) => p !== value),
      });
    } else {
      setForm({
        ...form,
        platform: [...form.platform, value],
      });
    }
  };

  useEffect(() => {
    setStatus(null);
    setText("");
    setImages([]);
    setCta(null);
    setVideoUrl("");
    setVideoDraft(null);
    setVideoProgress(null);
  }, [location.pathname]);

  const handleManualImages = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
      const dataUrls = await Promise.all(files.map(readFileAsDataUrl));
      setManualImages((prev) => [...prev, ...dataUrls].slice(0, 10));
    } catch (err) {
      alert(err.message || "Could not read image files");
    } finally {
      e.target.value = "";
    }
  };

  const removeManualImage = (index) => {
    setManualImages((prev) => prev.filter((_, i) => i !== index));
  };

  const validateCommon = () => {
    if (!form.scheduledTime) {
      alert("Please select post time");
      return false;
    }
    if (!form.platform.length) {
      alert("Please select at least one platform");
      return false;
    }
    return true;
  };

  const applyResponse = (res) => {
    setText(res.data.text || "");
    setCta(res.data.cta || (activeTab === "ai" ? buildCtaFromForm() : null));

    if (Array.isArray(res.data.images) && res.data.images.length > 0) {
      // Manual API returns /uploads/... paths — prefix API host for the browser
      const resolved = res.data.images.map((img) => {
        if (!img || typeof img !== "string") return img;
        if (img.startsWith("data:") || /^https?:\/\//i.test(img)) return img;
        if (img.startsWith("/uploads/")) return `${apiBase()}${img}`;
        // Legacy disk path fallback — keep client preview if available
        return img;
      });
      const usable = resolved.filter(
        (img) =>
          typeof img === "string" &&
          (img.startsWith("data:") ||
            img.startsWith("http://") ||
            img.startsWith("https://"))
      );
      if (usable.length > 0) {
        setImages(usable);
      } else if (activeTab === "manual" && manualImages.length > 0) {
        setImages(manualImages);
      } else {
        setImages([]);
      }
    } else if (res.data.image) {
      setImages([res.data.image]);
    } else if (activeTab === "manual" && manualImages.length > 0) {
      setImages(manualImages);
    } else {
      setImages([]);
    }

    setStatus({
      ok: res.data.success !== false,
      message: res.data.message || "Done",
      posting: res.data.posting || {},
      postsPerDay: res.data.postsPerDay,
      scheduledTime: res.data.scheduledTime,
      platforms: res.data.platforms || form.platform,
    });
  };

  const handleAiSubmit = async () => {
    try {
      if (!form.company || !form.industry) {
        alert("Company & Industry required");
        return;
      }
      if (!validateCommon()) return;

      setLoading(true);
      setStatus(null);
      setText("");
      setImages([]);
      setCta(null);
      setVideoUrl("");

      const res = await axios.post(
        `${apiBase()}/api/generate`,
        form,
        { timeout: 600000 }
      );
      applyResponse(res);
    } catch (err) {
      console.log(err);
      const apiError =
        err.response?.data?.error ||
        err.message ||
        "Error generating content";
      setStatus({
        ok: false,
        message: apiError,
        posting: err.response?.data?.posting || {},
      });
      alert(apiError);
    } finally {
      setLoading(false);
    }
  };

  const handleManualSubmit = async () => {
    try {
      if (!manualCaption.trim()) {
        alert("Please paste a caption");
        return;
      }
      if (!manualImages.length) {
        alert("Please upload at least one image");
        return;
      }
      if (!validateCommon()) return;

      setLoading(true);
      setStatus(null);
      setText("");
      setImages([]);
      setCta(null);
      setVideoUrl("");

      const res = await axios.post(
        `${apiBase()}/api/generate`,
        {
          mode: "manual",
          company: form.company || "Manual post",
          industry: form.industry || "",
          website: form.website,
          inquiryUrl: form.inquiryUrl,
          whatsapp: form.whatsapp,
          platform: form.platform,
          postsPerDay: form.postsPerDay,
          scheduledTime: form.scheduledTime,
          text: manualCaption.trim(),
          images: manualImages,
        },
        { timeout: 120000 }
      );
      applyResponse(res);
    } catch (err) {
      console.log(err);
      const apiError =
        err.response?.data?.error ||
        err.message ||
        "Error scheduling manual post";
      setStatus({
        ok: false,
        message: apiError,
        posting: err.response?.data?.posting || {},
      });
      alert(apiError);
    } finally {
      setLoading(false);
    }
  };

  const handleVideoSubmit = async () => {
    try {
      if (!videoTopic.trim()) {
        alert("Please enter a video topic or keyword");
        return;
      }

      setLoading(true);
      setStatus(null);
      setText("");
      setImages([]);
      setCta(null);
      setVideoUrl("");
      setVideoDraft(null);
      const jobId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `job_${Date.now()}`;
      setVideoProgress({
        progress: 2,
        stage: "script",
        label: "Starting…",
        status: "running",
      });

      const poll = setInterval(async () => {
        try {
          const { data } = await axios.get(
            `${apiBase()}/api/video-progress/${jobId}`,
            { timeout: 4000 }
          );
          if (data) setVideoProgress(data);
        } catch {
          /* keep last known progress */
        }
      }, 700);

      try {
        const res = await axios.post(
          `${apiBase()}/api/generate-video`,
          {
            jobId,
            topic: videoTopic.trim(),
            script: videoScript.trim(),
            language: videoLanguage,
            voice: videoVoice,
            aspect: videoAspect,
            duration: videoDuration,
            company: form.company,
            industry: form.industry,
            website: form.website,
            inquiryUrl: form.inquiryUrl,
            whatsapp: form.whatsapp,
            audience: form.audience,
            country: form.country,
          },
          { timeout: 600000 }
        );
        setVideoProgress({
          progress: 100,
          stage: "finish",
          label: "Video ready",
          status: "done",
        });
        applyResponse(res);
        const preview =
          res.data.video ||
          (Array.isArray(res.data.videos) ? res.data.videos[0] : "");
        if (preview) {
          const resolved =
            preview.startsWith("/uploads/") ? `${apiBase()}${preview}` : preview;
          setVideoUrl(resolved);
          setVideoDraft({
            video: preview,
            text: res.data.text || "",
          });
        }
      } finally {
        clearInterval(poll);
      }
    } catch (err) {
      console.log(err);
      const apiError =
        err.response?.data?.error ||
        err.message ||
        "Error generating video";
      setStatus({
        ok: false,
        message: apiError,
        posting: err.response?.data?.posting || {},
      });
      alert(apiError);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmVideo = async () => {
    try {
      if (!videoDraft?.video) {
        alert("Generate a video first");
        return;
      }
      if (!validateCommon()) return;

      setConfirming(true);
      const res = await axios.post(
        `${apiBase()}/api/confirm-video`,
        {
          video: videoDraft.video,
          text: videoDraft.text || text,
          company: form.company,
          industry: form.industry,
          website: form.website,
          inquiryUrl: form.inquiryUrl,
          whatsapp: form.whatsapp,
          audience: form.audience,
          country: form.country,
          platform: form.platform,
          postsPerDay: form.postsPerDay,
          scheduledTime: form.scheduledTime,
        },
        { timeout: 60000 }
      );
      applyResponse(res);
      setVideoDraft(null);
    } catch (err) {
      console.log(err);
      const apiError =
        err.response?.data?.error ||
        err.message ||
        "Could not schedule video";
      setStatus({
        ok: false,
        message: apiError,
        posting: err.response?.data?.posting || {},
      });
      alert(apiError);
    } finally {
      setConfirming(false);
    }
  };

  const handleDiscardVideo = () => {
    setVideoDraft(null);
    setStatus({
      ok: true,
      message: "Not posted. Video was kept for preview only — generate again if you want a new one.",
      posting: {},
    });
  };

  const postingEntries = status?.posting
    ? Object.entries(status.posting).filter(([, v]) => v != null)
    : [];

  const platformPicker = (
    <div className="mt-4">
      <label className="form-label fw-bold">Platforms</label>
      <div className="d-flex gap-4 flex-wrap">
        <div
          className={`p-3 border rounded text-center ${
            form.platform.includes("Facebook") ? "bg-primary text-white" : ""
          }`}
          style={{ cursor: "pointer", width: "120px" }}
          onClick={() => handlePlatformChange("Facebook")}
        >
          <i className="bi bi-facebook fs-3"></i>
          <div>Facebook</div>
        </div>

        <div
          className={`p-3 border rounded text-center ${
            form.platform.includes("Instagram") ? "bg-danger text-white" : ""
          }`}
          style={{ cursor: "pointer", width: "120px" }}
          onClick={() => handlePlatformChange("Instagram")}
        >
          <i className="bi bi-instagram fs-3"></i>
          <div>Instagram</div>
        </div>
      </div>
    </div>
  );

  const scheduleRow = (
    <div className="row mt-3 g-3">
      <div className="col-md-6">
        <select
          className="form-select"
          value={form.postsPerDay}
          onChange={(e) =>
            setForm({ ...form, postsPerDay: Number(e.target.value) })
          }
        >
          <option value={1}>1 Post / day</option>
          <option value={2}>2 Posts / day</option>
          <option value={3}>3 Posts / day</option>
        </select>
      </div>

      <div className="col-md-6">
        <input
          type="time"
          className="form-control"
          value={form.scheduledTime}
          onChange={(e) =>
            setForm({ ...form, scheduledTime: e.target.value })
          }
        />
      </div>
    </div>
  );

  const statusBlock =
    status && (
      <div
        className={`alert mt-4 mb-0 ${
          status.ok ? "alert-success" : "alert-warning"
        }`}
      >
        <div className="fw-semibold">{status.message}</div>

        {status.scheduledTime && (
          <div className="small mt-1">
            Saved for schedule: {status.scheduledTime}
            {status.postsPerDay
              ? ` · ${status.postsPerDay} post(s)/day`
              : ""}
          </div>
        )}

        {postingEntries.length > 0 && (
          <ul className="mb-0 mt-2 small">
            {postingEntries.map(([platform, result]) => (
              <li key={platform}>
                <strong>{platform}:</strong>{" "}
                {result.queued ? (
                  <span className="text-primary">
                    {result.mode === "scheduled"
                      ? "Scheduled (cron will post at set time)"
                      : "Queued on server (posts in background)"}
                  </span>
                ) : result.success ? (
                  <span className="text-success">Posted</span>
                ) : (
                  <span className="text-danger">
                    Failed — {result.error || "unknown error"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  const previewBlock = (
    <>
      {text && (
        <div className="mt-4">
          <h5>
            {activeTab === "manual"
              ? "📝 Caption"
              : activeTab === "video"
                ? "📝 Video caption"
                : "📝 Generated Post"}
          </h5>
          <div
            className="bg-light p-3 rounded"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {text}
          </div>
        </div>
      )}

      {videoUrl && (
        <div className="mt-4">
          <h5>🎬 Generated video</h5>
          <video
            src={videoUrl}
            controls
            playsInline
            className="w-100 rounded shadow"
            style={{
              maxHeight: videoAspect === "9:16" ? "520px" : "360px",
              background: "#111",
            }}
          />
          {videoDraft && (
            <div className="alert alert-info mt-3 mb-0">
              <div className="fw-bold">Is this video good enough to post?</div>
              <div className="small mt-1">
                Agar video acchi nahi lagi, <strong>Don&apos;t post</strong>{" "}
                dabao. Platforms aur time select karke confirm karo tabhi
                schedule hoga.
              </div>
              <div className="d-flex flex-wrap gap-2 mt-3">
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={handleConfirmVideo}
                  disabled={confirming || loading}
                >
                  {confirming ? "Scheduling..." : "Yes, schedule post"}
                </button>
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={handleDiscardVideo}
                  disabled={confirming || loading}
                >
                  No, don&apos;t post
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {(cta?.website || cta?.inquiry || cta?.whatsapp) && (
        <div className="d-flex flex-wrap gap-2 mt-3">
          {cta.website && (
            <a
              href={cta.website}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Website
            </a>
          )}
          {cta.inquiry && (
            <a
              href={cta.inquiry}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-warning text-white"
            >
              Raise Inquiry
            </a>
          )}
          {cta.whatsapp && (
            <a
              href={cta.whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-success"
            >
              WhatsApp
            </a>
          )}
        </div>
      )}

      {images.length > 0 && (
        <div className="row mt-3">
          {images.map((img, i) => (
            <div className="col-md-6 mb-3" key={i}>
              <img
                src={img}
                alt={activeTab === "manual" ? "Uploaded" : "AI"}
                className="img-fluid rounded shadow"
              />
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="container py-5">
      <div className="card shadow-lg p-4 mx-auto" style={{ maxWidth: "700px" }}>
        <h3 className="text-center mb-4">🚀 AI Marketing Tool</h3>

        <ul className="nav nav-tabs mb-4">
          <li className="nav-item">
            <NavLink
              to="/"
              end
              className={() =>
                `nav-link ${activeTab === "ai" ? "active" : ""}`
              }
            >
              AI Generated
            </NavLink>
          </li>
          <li className="nav-item">
            <NavLink
              to="/manual"
              className={({ isActive }) =>
                `nav-link ${isActive ? "active" : ""}`
              }
            >
              Manual
            </NavLink>
          </li>
          <li className="nav-item">
            <NavLink
              to="/ai-video"
              className={({ isActive }) =>
                `nav-link ${isActive ? "active" : ""}`
              }
            >
              AI Video
            </NavLink>
          </li>
        </ul>

        {activeTab === "ai" ? (
          <>
            <div className="row g-3">
              <div className="col-md-6">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Company"
                  value={form.company}
                  onChange={(e) =>
                    setForm({ ...form, company: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Industry"
                  value={form.industry}
                  onChange={(e) =>
                    setForm({ ...form, industry: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="url"
                  className="form-control"
                  placeholder="Website "
                  value={form.website}
                  onChange={(e) =>
                    setForm({ ...form, website: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="url"
                  className="form-control"
                  placeholder="Inquiry URL (optional, defaults to website)"
                  value={form.inquiryUrl}
                  onChange={(e) =>
                    setForm({ ...form, inquiryUrl: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="tel"
                  className="form-control"
                  placeholder="WhatsApp number (e.g. +966501234567)"
                  value={form.whatsapp}
                  onChange={(e) =>
                    setForm({ ...form, whatsapp: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Audience"
                  value={form.audience}
                  onChange={(e) =>
                    setForm({ ...form, audience: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Country"
                  value={form.country}
                  onChange={(e) =>
                    setForm({ ...form, country: e.target.value })
                  }
                />
              </div>
            </div>

            {platformPicker}
            {scheduleRow}

            <button
              onClick={handleAiSubmit}
              className="btn btn-primary w-100 mt-4"
              disabled={loading}
            >
              {loading ? "Generating & posting..." : "Generate Content"}
            </button>
          </>
        ) : activeTab === "manual" ? (
          <>
            <div className="mb-3">
              <label className="form-label fw-bold">Company (optional)</label>
              <input
                type="text"
                className="form-control"
                placeholder="Company name for your records"
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
              />
            </div>

            <div className="mb-3">
              <label className="form-label fw-bold">Caption</label>
              <textarea
                className="form-control"
                rows={6}
                placeholder="Paste your caption here..."
                value={manualCaption}
                onChange={(e) => setManualCaption(e.target.value)}
              />
            </div>

            <div className="mb-3">
              <label className="form-label fw-bold">Upload images</label>
              <input
                type="file"
                className="form-control"
                accept="image/*"
                multiple
                onChange={handleManualImages}
              />
              {manualImages.length > 0 && (
                <>
                  <div className="d-flex justify-content-between align-items-center mt-2">
                    <small className="text-muted">
                      {manualImages.length} image(s) selected
                    </small>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger"
                      onClick={() => setManualImages([])}
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="row mt-2">
                    {manualImages.map((img, i) => (
                      <div className="col-md-4 mb-2" key={i}>
                        <div className="position-relative">
                          <img
                            src={img}
                            alt={`Upload ${i + 1}`}
                            className="img-fluid rounded border"
                          />
                          <button
                            type="button"
                            className="btn btn-sm btn-danger position-absolute top-0 end-0 m-1"
                            onClick={() => removeManualImage(i)}
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {platformPicker}
            {scheduleRow}

            <button
              onClick={handleManualSubmit}
              className="btn btn-success w-100 mt-4"
              disabled={loading}
            >
              {loading ? "Scheduling..." : "Schedule Manual Post"}
            </button>
          </>
        ) : (
          <>
            <p className="text-muted small mb-3">
              Topic se HD short video (script, voice, footage, subtitles) —
              Reels / Shorts ke liye. MoneyPrinterTurbo jaisa workflow.
            </p>

            <div className="mb-3">
              <label className="form-label fw-bold">Topic / keyword</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Why solar panels save money in India"
                value={videoTopic}
                onChange={(e) => setVideoTopic(e.target.value)}
              />
            </div>

            <div className="mb-3">
              <label className="form-label fw-bold">
                Custom script (optional)
              </label>
              <textarea
                className="form-control"
                rows={4}
                placeholder="Leave blank to auto-generate the voiceover script"
                value={videoScript}
                onChange={(e) => setVideoScript(e.target.value)}
              />
            </div>

            <div className="row g-3 mb-3">
              <div className="col-6 col-md-3">
                <label className="form-label">Language</label>
                <select
                  className="form-select"
                  value={videoLanguage}
                  onChange={(e) => {
                    const language = e.target.value;
                    setVideoLanguage(language);
                    setVideoVoice(
                      language === "hi"
                        ? "hi-female"
                        : language === "ar"
                          ? "ar-male"
                          : "en-in"
                    );
                  }}
                >
                  <option value="en">English</option>
                  <option value="hi">Hindi</option>
                  <option value="ar">Arabic</option>
                </select>
              </div>
              <div className="col-6 col-md-3">
                <label className="form-label">Voice</label>
                <select
                  className="form-select"
                  value={videoVoice}
                  onChange={(e) => {
                    const voice = e.target.value;
                    setVideoVoice(voice);
                    setVideoLanguage(
                      voice.startsWith("hi")
                        ? "hi"
                        : voice.startsWith("ar")
                          ? "ar"
                          : "en"
                    );
                  }}
                >
                  <option value="en-in">English (India)</option>
                  <option value="en-female">English Female</option>
                  <option value="en-male">English Male</option>
                  <option value="hi-female">Hindi Female</option>
                  <option value="hi-male">Hindi Male</option>
                  <option value="ar-male">Arabic Male</option>
                  <option value="ar-female">Arabic Female</option>
                </select>
              </div>
              <div className="col-6 col-md-3">
                <label className="form-label">Aspect</label>
                <select
                  className="form-select"
                  value={videoAspect}
                  onChange={(e) => setVideoAspect(e.target.value)}
                >
                  <option value="9:16">9:16 Reels / Shorts</option>
                  <option value="16:9">16:9 Landscape</option>
                </select>
              </div>
              <div className="col-6 col-md-3">
                <label className="form-label">Duration</label>
                <select
                  className="form-select"
                  value={videoDuration}
                  onChange={(e) => setVideoDuration(Number(e.target.value))}
                >
                  <option value={10}>10 seconds</option>
                  <option value={15}>15 seconds</option>
                  <option value={20}>20 seconds</option>
                  <option value={30}>30 seconds</option>
                  <option value={45}>45 seconds</option>
                  <option value={60}>60 seconds</option>
                </select>
              </div>
            </div>

            <div className="row g-3">
              <div className="col-md-6">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Company (optional, for caption)"
                  value={form.company}
                  onChange={(e) =>
                    setForm({ ...form, company: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Industry (optional)"
                  value={form.industry}
                  onChange={(e) =>
                    setForm({ ...form, industry: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="url"
                  className="form-control"
                  placeholder="Website (optional CTA)"
                  value={form.website}
                  onChange={(e) =>
                    setForm({ ...form, website: e.target.value })
                  }
                />
              </div>
              <div className="col-md-6">
                <input
                  type="tel"
                  className="form-control"
                  placeholder="WhatsApp (optional CTA)"
                  value={form.whatsapp}
                  onChange={(e) =>
                    setForm({ ...form, whatsapp: e.target.value })
                  }
                />
              </div>
            </div>

            {platformPicker}
            {scheduleRow}

            <p className="text-muted small mt-3 mb-0">
              Pehle video generate karo, preview dekho, phir confirm karoge tabhi
              platform pe schedule hoga.
            </p>

            <button
              onClick={handleVideoSubmit}
              className="btn btn-dark w-100 mt-3"
              disabled={loading || confirming}
            >
              {loading
                ? "Generating video (script, voice, footage)..."
                : "Generate Short Video"}
            </button>

            {loading && (
              <div className="wa-status mt-3">
                <div className="wa-status-track">
                  {VIDEO_STAGES.map((stage) => (
                    <div className="wa-status-seg" key={stage.id}>
                      <div
                        className="wa-status-seg-fill"
                        style={{
                          width: `${segmentFill(
                            stage.id,
                            videoProgress?.progress || 0,
                            videoProgress?.stage
                          )}%`,
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="wa-status-labels">
                  {VIDEO_STAGES.map((stage) => {
                    const fill = segmentFill(
                      stage.id,
                      videoProgress?.progress || 0,
                      videoProgress?.stage
                    );
                    const cls =
                      fill >= 100
                        ? "done"
                        : videoProgress?.stage === stage.id
                          ? "active"
                          : "";
                    return (
                      <span className={cls} key={stage.id}>
                        {stage.label}
                      </span>
                    );
                  })}
                </div>
                <div className="wa-status-meta">
                  <span>{videoProgress?.label || "Working…"}</span>
                  <span>
                    {Math.round(Number(videoProgress?.progress) || 0)}%
                  </span>
                </div>
              </div>
            )}
          </>
        )}

        {statusBlock}
        {previewBlock}
      </div>
    </div>
  );
}
