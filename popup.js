const STORAGE_KEYS = {
  draft: "quickMemoDraft",
  history: "quickMemoHistory",
  theme: "quickMemoTheme",
  historyLimit: "quickMemoHistoryLimit",
};

const DEFAULT_HISTORY_LIMIT = 100;
const SAVE_STATUS_RESET_MS = 1_400;
const STATUS_MESSAGE_RESET_MS = 2_000;
const TAG_COLORS = new Set(["blue", "green", "pink", "purple", "gray"]);
const HISTORY_LIMITS = new Set([50, 100, 300, "unlimited"]);

const elements = {
  memoInput: document.querySelector("#memoInput"),
  memoCharacterCount: document.querySelector("#memoCharacterCount"),
  tagInput: document.querySelector("#tagInput"),
  tagColorSelect: document.querySelector("#tagColorSelect"),
  themeToggleButton: document.querySelector("#themeToggleButton"),
  historyLimitSelect: document.querySelector("#historyLimitSelect"),
  historyCount: document.querySelector("#historyCount"),
  resetSettingsButton: document.querySelector("#resetSettingsButton"),
  saveButton: document.querySelector("#saveButton"),
  clearDraftButton: document.querySelector("#clearDraftButton"),
  downloadAllButton: document.querySelector("#downloadAllButton"),
  clearAllButton: document.querySelector("#clearAllButton"),
  historySearch: document.querySelector("#historySearch"),
  tagFilterStatus: document.querySelector("#tagFilterStatus"),
  tagFilterLabel: document.querySelector("#tagFilterLabel"),
  clearTagFilterButton: document.querySelector("#clearTagFilterButton"),
  historyList: document.querySelector("#historyList"),
  emptyState: document.querySelector("#emptyState"),
  saveStatus: document.querySelector("#saveStatus"),
  statusMessage: document.querySelector("#statusMessage"),
  template: document.querySelector("#historyItemTemplate"),
};

let historyItems = [];
let currentTheme = "light";
let historyLimit = DEFAULT_HISTORY_LIMIT;
let activeTag = "";
let statusTimerId;
let statusMessageTimerId;

const storage = {
  get(keys) {
    return chrome.storage.local.get(keys);
  },
  set(values) {
    return chrome.storage.local.set(values);
  },
};

const setStatus = (message) => {
  elements.saveStatus.textContent = message;
  clearTimeout(statusTimerId);

  if (message !== "保存済み") return;

  statusTimerId = setTimeout(() => {
    elements.saveStatus.textContent = "自動保存中";
  }, SAVE_STATUS_RESET_MS);
};

const showStatus = (message) => {
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.add("is-visible");
  clearTimeout(statusMessageTimerId);

  statusMessageTimerId = setTimeout(() => {
    elements.statusMessage.textContent = "";
    elements.statusMessage.classList.remove("is-visible");
  }, STATUS_MESSAGE_RESET_MS);
};

const clearStatusMessage = () => {
  elements.statusMessage.textContent = "";
  elements.statusMessage.classList.remove("is-visible");
  clearTimeout(statusMessageTimerId);
};

const formatDateTime = (isoString) =>
  new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoString));

const formatFileDateTime = (date = new Date()) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replaceAll(":", "-");

const normalizeHistory = (value) =>
  Array.isArray(value)
    ? value.map((item) => ({
        ...item,
        pinned: Boolean(item.pinned),
        tags: normalizeTags(item.tags),
      }))
    : [];

const normalizeTheme = (value) => (value === "dark" ? "dark" : "light");

const normalizeHistoryLimit = (value) => {
  if (value === "unlimited") return "unlimited";

  const limit = Number(value);
  return HISTORY_LIMITS.has(limit) ? limit : DEFAULT_HISTORY_LIMIT;
};

const normalizeTagColor = (value) => (TAG_COLORS.has(value) ? value : "gray");

const normalizeTags = (value) => {
  const source = Array.isArray(value) ? value : [];
  const tagMap = new Map();

  for (const tag of source) {
    const name = typeof tag === "object" && tag !== null ? String(tag.name ?? "").trim() : String(tag).trim();
    if (!name || tagMap.has(name)) continue;

    const color = typeof tag === "object" && tag !== null ? normalizeTagColor(tag.color) : "gray";
    tagMap.set(name, { name, color });
  }

  return [...tagMap.values()];
};

const parseTags = (value, color) =>
  normalizeTags(
    value.split(/[、,]/).map((name) => ({
      name,
      color,
    })),
  );

const getTagNames = (tags) => tags.map((tag) => tag.name);

const createTxtContent = (items) =>
  items
    .map((item) => {
      const lines = [`日時: ${formatDateTime(item.createdAt)}`];
      if (item.tags.length > 0) {
        lines.push(`タグ: ${getTagNames(item.tags).join("、")}`);
      }
      lines.push(item.text);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");

const getHistorySearchQuery = () => elements.historySearch.value.trim().toLowerCase();

const getFilteredHistoryItems = () => {
  const query = getHistorySearchQuery();
  const searchedItems = query
    ? historyItems.filter((item) => {
        const searchableText = `${item.text}\n${formatDateTime(item.createdAt)}\n${getTagNames(item.tags).join("\n")}`.toLowerCase();
        return searchableText.includes(query);
      })
    : historyItems;
  const filteredItems = activeTag
    ? searchedItems.filter((item) => item.tags.some((tag) => tag.name === activeTag))
    : searchedItems;

  return [...filteredItems].sort((first, second) => {
    if (first.pinned === second.pinned) return 0;
    return first.pinned ? -1 : 1;
  });
};

const saveWithFilePicker = async ({ filename, content }) => {
  const fileHandle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [
      {
        description: "Text file",
        accept: {
          "text/plain": [".txt"],
        },
      },
    ],
  });
  const writable = await fileHandle.createWritable();
  await writable.write(new Blob([content], { type: "text/plain;charset=utf-8" }));
  await writable.close();
};

const saveWithDownloadsApi = async ({ filename, content }) => {
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;

  await chrome.downloads.download({
    url,
    filename,
    saveAs: true,
  });
};

const downloadTxt = async ({ filename, content }) => {
  if ("showSaveFilePicker" in window) {
    await saveWithFilePicker({ filename, content });
    return;
  }

  await saveWithDownloadsApi({ filename, content });
};

const copyText = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const temporaryInput = document.createElement("textarea");
  temporaryInput.value = text;
  temporaryInput.setAttribute("readonly", "");
  temporaryInput.style.position = "fixed";
  temporaryInput.style.inset = "-9999px";
  document.body.append(temporaryInput);
  temporaryInput.select();

  const copied = document.execCommand("copy");
  temporaryInput.remove();

  if (!copied) {
    throw new Error("Copy command failed");
  }
};

const persistDraft = async (draft) => {
  await storage.set({ [STORAGE_KEYS.draft]: draft });
  setStatus("保存済み");
};

const persistHistory = async () => {
  await storage.set({ [STORAGE_KEYS.history]: historyItems });
};

const updateMemoCharacterCount = () => {
  elements.memoCharacterCount.textContent = `${elements.memoInput.value.length}文字`;
};

const updateHistoryCount = () => {
  elements.historyCount.textContent = `履歴：${historyItems.length}件`;
};

const applyHistoryLimit = () => {
  if (historyLimit === "unlimited") return false;

  let removed = false;
  while (historyItems.length > historyLimit) {
    let removableIndex = -1;
    for (let index = historyItems.length - 1; index >= 0; index -= 1) {
      if (!historyItems[index].pinned) {
        removableIndex = index;
        break;
      }
    }

    if (removableIndex === -1) break;

    historyItems.splice(removableIndex, 1);
    removed = true;
  }

  return removed;
};

const applyHistoryLimitSetting = (value) => {
  historyLimit = normalizeHistoryLimit(value);
  elements.historyLimitSelect.value = String(historyLimit);
};

const applyTheme = (theme) => {
  currentTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = currentTheme;
  elements.themeToggleButton.textContent = currentTheme === "dark" ? "☀️" : "🌙";
  elements.themeToggleButton.setAttribute(
    "aria-label",
    currentTheme === "dark" ? "ライトテーマに切り替え" : "ダークテーマに切り替え",
  );
};

const persistTheme = async (theme) => {
  await storage.set({ [STORAGE_KEYS.theme]: normalizeTheme(theme) });
};

const renderHistory = () => {
  const query = getHistorySearchQuery();
  const filteredItems = getFilteredHistoryItems();

  elements.historyList.replaceChildren();
  elements.tagFilterStatus.hidden = !activeTag;
  elements.tagFilterLabel.textContent = activeTag ? `タグ：${activeTag}で絞り込み中` : "";
  elements.emptyState.textContent =
    (query || activeTag) && filteredItems.length === 0 ? "該当する履歴がありません" : "まだ履歴はありません。";
  elements.emptyState.classList.toggle("is-visible", filteredItems.length === 0);
  elements.clearAllButton.disabled = historyItems.length === 0;
  updateHistoryCount();

  const fragment = document.createDocumentFragment();

  for (const item of filteredItems) {
    const row = elements.template.content.firstElementChild.cloneNode(true);
    const pinnedBadge = row.querySelector(".pinned-badge");
    const date = row.querySelector(".history-date");
    const text = row.querySelector(".history-text");
    const tags = row.querySelector(".history-tags");
    const pinButton = row.querySelector(".pin-button");
    const copyButton = row.querySelector(".copy-button");
    const downloadButton = row.querySelector(".download-button");
    const deleteButton = row.querySelector(".delete-button");

    row.classList.toggle("is-pinned", item.pinned);
    pinnedBadge.hidden = !item.pinned;
    date.dateTime = item.createdAt;
    date.textContent = formatDateTime(item.createdAt);
    text.textContent = item.text;
    tags.hidden = item.tags.length === 0;
    for (const tag of item.tags) {
      const tagButton = document.createElement("button");
      tagButton.className = `tag-chip tag-chip-${tag.color}`;
      tagButton.type = "button";
      tagButton.textContent = tag.name;
      tagButton.dataset.tag = tag.name;
      tags.append(tagButton);
    }
    pinButton.textContent = item.pinned ? "ピン留め解除" : "ピン留め";
    pinButton.setAttribute("aria-pressed", String(item.pinned));
    pinButton.dataset.id = item.id;
    copyButton.dataset.id = item.id;
    downloadButton.dataset.id = item.id;
    deleteButton.dataset.id = item.id;

    fragment.append(row);
  }

  elements.historyList.append(fragment);
};

const handleSaveAndClear = async () => {
  const text = elements.memoInput.value.trim();
  const tags = parseTags(elements.tagInput.value, elements.tagColorSelect.value);
  if (!text) {
    setStatus("メモが空です");
    return;
  }

  historyItems = [
    {
      id: crypto.randomUUID(),
      text,
      tags,
      createdAt: new Date().toISOString(),
      pinned: false,
    },
    ...historyItems,
  ];

  applyHistoryLimit();

  elements.memoInput.value = "";
  elements.tagInput.value = "";
  updateMemoCharacterCount();

  await storage.set({
    [STORAGE_KEYS.draft]: "",
    [STORAGE_KEYS.history]: historyItems,
  });

  renderHistory();
  setStatus("履歴に保存しました");
};

const handleClearDraft = async () => {
  elements.memoInput.value = "";
  elements.tagInput.value = "";
  updateMemoCharacterCount();
  await persistDraft("");
  elements.memoInput.focus();
};

const handleHistoryClick = async (event) => {
  const tagButton = event.target.closest(".tag-chip");
  if (tagButton) {
    activeTag = tagButton.dataset.tag;
    renderHistory();
    return;
  }

  const pinButton = event.target.closest(".pin-button");
  if (pinButton) {
    const target = historyItems.find((item) => item.id === pinButton.dataset.id);
    if (!target) return;

    target.pinned = !target.pinned;
    applyHistoryLimit();
    await persistHistory();
    renderHistory();
    setStatus(target.pinned ? "ピン留めしました" : "ピン留めを解除しました");
    return;
  }

  const copyButton = event.target.closest(".copy-button");
  if (copyButton) {
    const target = historyItems.find((item) => item.id === copyButton.dataset.id);
    if (!target) return;

    await copyText(target.text);
    showStatus("コピーしました");
    return;
  }

  const downloadButton = event.target.closest(".download-button");
  if (downloadButton) {
    const target = historyItems.find((item) => item.id === downloadButton.dataset.id);
    if (!target) return;

    await downloadTxt({
      filename: `quick-memo-${formatFileDateTime(new Date(target.createdAt))}.txt`,
      content: createTxtContent([target]),
    });
    setStatus("保存しました");
    return;
  }

  const button = event.target.closest(".delete-button");
  if (!button) return;

  const targetId = button.dataset.id;
  historyItems = historyItems.filter((item) => item.id !== targetId);
  await persistHistory();
  renderHistory();
  setStatus("履歴を削除しました");
};

const handleDownloadAll = async () => {
  if (historyItems.length === 0) {
    setStatus("保存する履歴がありません");
    return;
  }

  await downloadTxt({
    filename: `quick-memo-all-${formatFileDateTime()}.txt`,
    content: createTxtContent(historyItems),
  });
  setStatus("保存しました");
};

const handleClearAll = async () => {
  if (historyItems.length === 0) return;
  if (!window.confirm("ピン留め中の履歴も含めて全て削除しますか？")) return;

  historyItems = [];
  activeTag = "";
  elements.tagInput.value = "";
  elements.historySearch.value = "";
  await persistHistory();
  renderHistory();
  setStatus("全履歴を削除しました");
};

const handleResetSettings = async () => {
  if (!window.confirm("履歴は残したまま、設定だけ初期状態に戻しますか？")) return;

  applyTheme("light");
  applyHistoryLimitSetting(DEFAULT_HISTORY_LIMIT);
  activeTag = "";
  elements.historySearch.value = "";
  elements.tagInput.value = "";
  elements.tagColorSelect.value = "gray";
  clearStatusMessage();

  await storage.set({
    [STORAGE_KEYS.theme]: "light",
    [STORAGE_KEYS.historyLimit]: DEFAULT_HISTORY_LIMIT,
  });

  renderHistory();
  setStatus("設定をリセットしました");
};

const boot = async () => {
  const data = await storage.get([
    STORAGE_KEYS.draft,
    STORAGE_KEYS.history,
    STORAGE_KEYS.theme,
    STORAGE_KEYS.historyLimit,
  ]);
  applyTheme(data[STORAGE_KEYS.theme]);
  applyHistoryLimitSetting(data[STORAGE_KEYS.historyLimit]);
  elements.memoInput.value = data[STORAGE_KEYS.draft] ?? "";
  updateMemoCharacterCount();
  historyItems = normalizeHistory(data[STORAGE_KEYS.history]);
  const prunedHistory = applyHistoryLimit();
  if (prunedHistory) {
    await persistHistory();
  }

  renderHistory();
  setStatus("自動保存中");
};

elements.memoInput.addEventListener("input", (event) => {
  updateMemoCharacterCount();
  persistDraft(event.target.value).catch((error) => {
    console.error("Failed to save draft", error);
    setStatus("保存に失敗しました");
  });
});

elements.themeToggleButton.addEventListener("click", () => {
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  persistTheme(nextTheme).catch((error) => {
    console.error("Failed to save theme", error);
    setStatus("テーマ保存に失敗しました");
  });
});

elements.historyLimitSelect.addEventListener("change", () => {
  applyHistoryLimitSetting(elements.historyLimitSelect.value);
  applyHistoryLimit();
  storage
    .set({
      [STORAGE_KEYS.historyLimit]: historyLimit,
      [STORAGE_KEYS.history]: historyItems,
    })
    .then(() => {
      renderHistory();
      setStatus("設定を保存しました");
    })
    .catch((error) => {
      console.error("Failed to save history limit", error);
      setStatus("設定保存に失敗しました");
    });
});

elements.resetSettingsButton.addEventListener("click", () => {
  handleResetSettings().catch((error) => {
    console.error("Failed to reset settings", error);
    setStatus("設定リセットに失敗しました");
  });
});

elements.saveButton.addEventListener("click", () => {
  handleSaveAndClear().catch((error) => {
    console.error("Failed to save memo", error);
    setStatus("保存に失敗しました");
  });
});

elements.clearDraftButton.addEventListener("click", () => {
  handleClearDraft().catch((error) => {
    console.error("Failed to clear draft", error);
    setStatus("クリアに失敗しました");
  });
});

elements.historySearch.addEventListener("input", () => {
  renderHistory();
});

elements.clearTagFilterButton.addEventListener("click", () => {
  activeTag = "";
  renderHistory();
});

elements.downloadAllButton.addEventListener("click", () => {
  handleDownloadAll().catch((error) => {
    if (error.name === "AbortError") {
      setStatus("保存をキャンセルしました");
      return;
    }

    console.error("Failed to download history", error);
    setStatus("txt保存に失敗しました");
  });
});

elements.historyList.addEventListener("click", (event) => {
  handleHistoryClick(event).catch((error) => {
    if (error.name === "AbortError") {
      setStatus("保存をキャンセルしました");
      return;
    }

    console.error("Failed to handle history item", error);
    if (event.target.closest(".copy-button")) {
      showStatus("コピーできませんでした");
      return;
    }

    setStatus("処理に失敗しました");
  });
});

elements.clearAllButton.addEventListener("click", () => {
  handleClearAll().catch((error) => {
    console.error("Failed to clear history", error);
    setStatus("削除に失敗しました");
  });
});

boot().catch((error) => {
  console.error("Failed to initialize popup", error);
  setStatus("読み込みに失敗しました");
});
