const form = document.querySelector("#letterForm");
const submitButton = document.querySelector("#submitButton");
const formMessage = document.querySelector("#formMessage");
const connectionStatus = document.querySelector("#connectionStatus");
const dateInput = document.querySelector("#date");
const headshotInput = document.querySelector("#headshot");
const uploadTitle = document.querySelector("#uploadTitle");
const uploadHelp = document.querySelector("#uploadHelp");

setDefaultDate();
checkConnection();

document.querySelectorAll(".currency-input").forEach((input) => {
  input.addEventListener("blur", () => formatCurrency(input));
});

document.querySelectorAll(".percent-input").forEach((input) => {
  input.addEventListener("blur", () => formatPercent(input));
});

headshotInput.addEventListener("change", () => {
  const file = headshotInput.files?.[0];
  if (!file) {
    uploadTitle.textContent = "Choose a headshot";
    uploadHelp.textContent = "JPG, PNG, or WebP · maximum 10 MB";
    return;
  }

  uploadTitle.textContent = file.name;
  uploadHelp.textContent = formatFileSize(file.size);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();

  if (!form.reportValidity()) return;

  const headshot = headshotInput.files?.[0];
  if (headshot && headshot.size > 10 * 1024 * 1024) {
    showMessage("The headshot must be smaller than 10 MB.", "error");
    return;
  }

  setLoading(true);

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      body: new FormData(form)
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.details || payload.error || "The PDF could not be generated.");
    }

    const blob = await response.blob();
    const filename = getDownloadFilename(response.headers.get("Content-Disposition"));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    const editUrl = response.headers.get("X-Canva-Edit-Url");
    const editLink = editUrl
      ? ` <a href="${escapeAttribute(editUrl)}" target="_blank" rel="noopener">Open the Canva design</a>.`
      : "";
    showMessage(`Your completed PDF has downloaded.${editLink}`, "success", true);
  } catch (error) {
    showMessage(error.message || "The PDF could not be generated.", "error");
  } finally {
    setLoading(false);
  }
});

async function checkConnection() {
  try {
    const response = await fetch("/admin/status", { cache: "no-store" });
    const status = await response.json();
    connectionStatus.classList.remove("connected", "disconnected");

    if (status.connected) {
      connectionStatus.classList.add("connected");
      connectionStatus.lastChild.textContent = " Canva connected";
    } else if (status.configured) {
      connectionStatus.classList.add("disconnected");
      connectionStatus.lastChild.textContent = " Canva authorization needed";
    } else {
      connectionStatus.classList.add("disconnected");
      connectionStatus.lastChild.textContent = " Setup required";
    }
  } catch {
    connectionStatus.classList.add("disconnected");
    connectionStatus.lastChild.textContent = " Status unavailable";
  }
}

function setDefaultDate() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
  dateInput.value = formatter.format(new Date());
}

function formatCurrency(input) {
  const raw = input.value.trim();
  if (!raw) return;
  const number = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(number)) return;
  input.value = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(number) ? 0 : 2
  }).format(number);
}

function formatPercent(input) {
  const raw = input.value.trim();
  if (!raw) return;
  const number = Number(raw.replace(/[%\s]/g, ""));
  if (!Number.isFinite(number)) return;
  input.value = `${number}%`;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector(".button-label").textContent = loading
    ? "Creating your PDF…"
    : "Generate PDF";
}

function showMessage(message, type, allowHtml = false) {
  formMessage.className = `form-message visible ${type}`;
  if (allowHtml) {
    formMessage.innerHTML = message;
  } else {
    formMessage.textContent = message;
  }
  formMessage.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideMessage() {
  formMessage.className = "form-message";
  formMessage.textContent = "";
}

function getDownloadFilename(contentDisposition) {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  return match?.[1] || "pre-approval-letter.pdf";
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB selected`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB selected`;
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
