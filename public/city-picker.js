// Manage city suggestions and keep coordinates tied to the selected city.
export function createCityPicker(input, list, status) {
  let selected = null;
  let suggestions = [];
  let active = -1;
  let timer;
  let controller;
  let revision = 0;

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function highlight(index) {
    active = index;
    [...list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === index)));
    if (index >= 0) {
      input.setAttribute("aria-activedescendant", "city-option-" + index);
      list.children[index]?.scrollIntoView({ block: "nearest" });
    }
  }
  function select(city) {
    revision++;
    clearTimeout(timer);
    controller?.abort();
    selected = city;
    input.value = city.label;
    input.setCustomValidity("");
    status.textContent = "";
    close();
  }
  async function lookup(version) {
    controller?.abort();
    controller = new AbortController();
    status.textContent = "Searching cities…";
    try {
      const response = await fetch("/api/cities?q=" + encodeURIComponent(input.value.trim()), { signal: controller.signal });
      const result = await response.json();
      if (version !== revision) return;
      if (!response.ok) throw new Error(result.error || "City search is unavailable. Please try again.");
      suggestions = result.cities;
      list.replaceChildren();
      suggestions.forEach((city, index) => {
        const option = document.createElement("li");
        option.id = "city-option-" + index;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.textContent = city.label;
        option.addEventListener("pointerdown", event => { event.preventDefault(); select(city); });
        list.append(option);
      });
      status.textContent = suggestions.length ? "" : "No cities found.";
      list.hidden = suggestions.length === 0;
      input.setAttribute("aria-expanded", String(suggestions.length > 0));
      if (suggestions.length) highlight(0);
    } catch (error) {
      if (version !== revision || error.name === "AbortError") return;
      close();
      status.textContent = error.message;
    }
  }
  input.addEventListener("input", () => {
    selected = null;
    input.setCustomValidity("Select a city from the list.");
    revision++;
    clearTimeout(timer);
    controller?.abort();
    close();
    status.textContent = "";
    if (input.value.trim().length >= 2) {
      const version = revision;
      timer = setTimeout(() => lookup(version), 300);
    }
  });
  input.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      revision++; clearTimeout(timer); controller?.abort(); close(); status.textContent = "";
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!list.hidden && suggestions.length) {
        event.preventDefault();
        highlight((active + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!list.hidden && active >= 0) select(suggestions[active]);
    }
  });
  input.addEventListener("blur", () => {
    revision++; clearTimeout(timer); controller?.abort(); close(); status.textContent = "";
  });
  input.addEventListener("focus", () => {
    if (!selected && input.value.trim().length >= 2) lookup(++revision);
  });
  return {
    getSelected: () => selected,
    requireSelection: () => {
      if (selected) return true;
      input.setCustomValidity("Select a city from the list.");
      input.reportValidity();
      return false;
    },
  };
}

