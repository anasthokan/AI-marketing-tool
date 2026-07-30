import { useState } from "react";
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

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("ai"); // "ai" | "manual"

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

  const switchTab = (tab) => {
    setActiveTab(tab);
    setStatus(null);
    setText("");
    setImages([]);
    setCta(null);
  };

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
          <h5>{activeTab === "manual" ? "📝 Caption" : "📝 Generated Post"}</h5>
          <div
            className="bg-light p-3 rounded"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {text}
          </div>
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
            <button
              type="button"
              className={`nav-link ${activeTab === "ai" ? "active" : ""}`}
              onClick={() => switchTab("ai")}
            >
              AI Generated
            </button>
          </li>
          <li className="nav-item">
            <button
              type="button"
              className={`nav-link ${activeTab === "manual" ? "active" : ""}`}
              onClick={() => switchTab("manual")}
            >
              Manual
            </button>
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
        ) : (
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

            <p className="text-muted small mb-3">
              No AI image generation — jo image aap upload karoge, wahi post hogi.
            </p>

            <div className="mb-3">
              <label className="form-label fw-bold">
                Upload images{" "}
                <span className="fw-normal text-muted">
                  (multiple OK — up to 10 for carousel)
                </span>
              </label>
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
        )}

        {statusBlock}
        {previewBlock}
      </div>
    </div>
  );
}
