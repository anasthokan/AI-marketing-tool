import { useState } from "react";
import axios from "axios";
import "bootstrap/dist/css/bootstrap.min.css";

export default function Dashboard() {
  const [form, setForm] = useState({
    company: "",
    industry: "",
    website: "",
    audience: "",
    country: "",
    platform: [],
    postsPerDay: 1,
    scheduledTime: "",
  });

  const [text, setText] = useState("");
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

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

  const handleSubmit = async () => {
    try {
      if (!form.company || !form.industry) {
        alert("Company & Industry required");
        return;
      }

      if (!form.scheduledTime) {
        alert("Please select post time");
        return;
      }

      if (!form.platform.length) {
        alert("Please select at least one platform");
        return;
      }

      setLoading(true);
      setStatus(null);
      setText("");
      setImages([]);

      // Production: IIS backend site (e.g. :522). Dev: localhost:5000
      const apiBase = (
        import.meta.env.VITE_API_URL || "http://localhost:5000"
      ).replace(/\/$/, "");
      const res = await axios.post(
        `${apiBase}/api/generate`,
        form,
        { timeout: 600000 }
      );

      setText(res.data.text || "");

      if (Array.isArray(res.data.images)) {
        setImages(res.data.images);
      } else if (res.data.image) {
        setImages([res.data.image]);
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

  const postingEntries = status?.posting
    ? Object.entries(status.posting).filter(([, v]) => v != null)
    : [];

  return (
    <div className="container py-5">
      <div className="card shadow-lg p-4 mx-auto" style={{ maxWidth: "700px" }}>
        <h3 className="text-center mb-4">🚀 AI Marketing Tool</h3>

        <div className="row g-3">
          {Object.keys(form)
            .slice(0, 5)
            .map((field) => (
              <div className="col-md-6" key={field}>
                <input
                  type="text"
                  className="form-control"
                  placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                  onChange={(e) =>
                    setForm({ ...form, [field]: e.target.value })
                  }
                />
              </div>
            ))}
        </div>

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

            {/* LinkedIn temporarily disabled
            <div
              className={`p-3 border rounded text-center ${
                form.platform.includes("LinkedIn") ? "bg-info text-white" : ""
              }`}
              style={{ cursor: "pointer", width: "120px" }}
              onClick={() => handlePlatformChange("LinkedIn")}
            >
              <i className="bi bi-linkedin fs-3"></i>
              <div>LinkedIn</div>
            </div>
            */}
          </div>
        </div>

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

        <button
          onClick={handleSubmit}
          className="btn btn-primary w-100 mt-4"
          disabled={loading}
        >
          {loading ? "Generating & posting..." : "Generate Content"}
        </button>

        {status && (
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
        )}

        {text && (
          <div className="mt-4">
            <h5>📝 Generated Post</h5>
            <div className="bg-light p-3 rounded">{text}</div>
          </div>
        )}

        {images.length > 0 && (
          <div className="row mt-3">
            {images.map((img, i) => (
              <div className="col-md-6 mb-3" key={i}>
                <img
                  src={img}
                  alt="AI"
                  className="img-fluid rounded shadow"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
