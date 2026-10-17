// Copy controls for the docs page. The page reads fully without this script.
const copy = async (text, button) => {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => (button.textContent = label), 1500);
};
if (navigator.clipboard) {
  for (const pre of document.querySelectorAll(".reading pre")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("click", () => copy(pre.querySelector("code").textContent, button));
    pre.append(button);
  }
  const page = document.querySelector(".copy-page");
  if (page) {
    page.hidden = false;
    page.addEventListener("click", async () => {
      const text = fetch(page.dataset.src).then((r) => {
        if (!r.ok) throw Error();
        return r.text();
      });
      // Give the clipboard the pending text, so the click permission is kept (Safari).
      if (window.ClipboardItem) {
        const label = page.textContent;
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) }),
          ]);
          page.textContent = "Copied";
        } catch {
          page.textContent = "Copy failed";
        }
        setTimeout(() => (page.textContent = label), 1500);
      } else copy(await text, page);
    });
  }
}
