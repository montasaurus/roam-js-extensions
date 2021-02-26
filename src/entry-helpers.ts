import { createIconButton, getAttrConfigFromQuery, getUids } from "roam-client";
import { isIOS, isMacOs } from "mobile-device-detect";
import { Dict } from "mixpanel-browser";
import { getTextByBlockUid, RoamBlock } from "roam-client";
import axios, { AxiosResponse } from "axios";

declare global {
  interface Window {
    roamjs?: {
      alerted: boolean;
      loaded: Set<string>;
      extension: {
        [id: string]: {
          [method: string]: (args?: unknown) => void;
        };
      };
      dynamicElements: Set<HTMLElement>;
    };
    roam42?: {
      smartBlocks?: {
        customCommands: {
          key: string; // `<% ${string} %> (SmartBlock function)`, sad - https://github.com/microsoft/TypeScript/issues/13969
          icon: "gear";
          value: string;
          processor: (match: string) => Promise<string | void>;
        }[];
        activeWorkflow: {
          outputAdditionalBlock: (text: string) => void;
        };
      };
    };
  }
}

const roamJsVersion = process.env.ROAMJS_VERSION || "0";

export const track = (
  eventName: string,
  properties?: Dict
): Promise<AxiosResponse> =>
  axios.post("https://api.roamjs.com/mixpanel", { eventName, properties });

export const runExtension = async (
  extensionId: string,
  run: () => void
): Promise<void> => {
  if (!window.roamjs) {
    window.roamjs = {
      alerted: false,
      loaded: new Set(),
      extension: {},
      dynamicElements: new Set(),
    };
  }
  if (window.roamjs.loaded.has(extensionId)) {
    return;
  }
  window.roamjs.loaded.add(extensionId);
  if (process.env.IS_LEGACY && !window.roamjs?.alerted) {
    window.roamjs.alerted = true;
    window.alert(
      'Hey! Thanks for using extensions from roam.davidvargas.me! I\'m currently migrating the extensions to roamjs.com. Please edit the src in your roam/js block, replacing "roam.davidvargas.me/master" with "roamjs.com"'
    );
    track("Legacy Alerted");
  }

  track("Load Extension", {
    extensionId,
    roamJsVersion,
  });
  run();
};

// update-block replaces with a new textarea
export const fixCursorById = ({
  id,
  start,
  end,
  focus,
}: {
  id: string;
  start: number;
  end: number;
  focus?: boolean;
}): number =>
  window.setTimeout(() => {
    const textArea = document.getElementById(id) as HTMLTextAreaElement;
    if (focus) {
      textArea.focus();
    }
    textArea.setSelectionRange(start, end);
  }, 100);

export const replaceText = ({
  before,
  after,
  prepend,
}: {
  before: string;
  after: string;
  prepend?: boolean;
}): void => {
  const textArea = document.activeElement as HTMLTextAreaElement;
  const id = textArea.id;
  const oldValue = textArea.value;
  const start = textArea.selectionStart;
  const end = textArea.selectionEnd;
  const text = !before
    ? prepend
      ? `${after} ${oldValue}`
      : `${oldValue}${after}`
    : oldValue.replace(`${before}${!after && prepend ? " " : ""}`, after);
  const { blockUid } = getUids(textArea);
  window.roamAlphaAPI.updateBlock({ block: { string: text, uid: blockUid } });
  const diff = text.length - oldValue.length;
  if (diff !== 0) {
    let index = 0;
    const maxIndex = Math.min(
      Math.max(oldValue.length, text.length),
      Math.max(start, end) + 1
    );
    for (index = 0; index < maxIndex; index++) {
      if (oldValue.charAt(index) !== text.charAt(index)) {
        break;
      }
    }
    const newStart = index > start ? start : start + diff;
    const newEnd = index > end ? end : end + diff;
    if (newStart !== start || newEnd !== end) {
      fixCursorById({
        id,
        start: newStart,
        end: newEnd,
      });
    }
  }
};

export const replaceTagText = ({
  before,
  after,
  addHash = false,
  prepend = false,
}: {
  before: string;
  after: string;
  addHash?: boolean;
  prepend?: boolean;
}): void => {
  if (before) {
    const textArea = document.activeElement as HTMLTextAreaElement;
    if (textArea.value.includes(`#[[${before}]]`)) {
      replaceText({
        before: `#[[${before}]]`,
        after: after ? `#[[${after}]]` : "",
        prepend,
      });
    } else if (textArea.value.includes(`[[${before}]]`)) {
      replaceText({
        before: `[[${before}]]`,
        after: after ? `[[${after}]]` : "",
        prepend,
      });
    } else if (textArea.value.includes(`#${before}`)) {
      const hashAfter = after.match(/(\s|\[\[.*\]\])/)
        ? `#[[${after}]]`
        : `#${after}`;
      replaceText({
        before: `#${before}`,
        after: after ? hashAfter : "",
        prepend,
      });
    }
  } else if (addHash) {
    const hashAfter = after.match(/(\s|\[\[.*\]\])/)
      ? `#[[${after}]]`
      : `#${after}`;
    replaceText({ before: "", after: hashAfter, prepend });
  } else {
    replaceText({ before: "", after: `[[${after}]]`, prepend });
  }
};

export const createObserver = (
  mutationCallback: (mutationList?: MutationRecord[]) => void
): void =>
  createDivObserver(
    mutationCallback,
    document.getElementsByClassName("roam-body")[0]
  );

const getMutatedNodes = ({
  ms,
  tag,
  className,
  nodeList,
}: {
  ms: MutationRecord[];
  tag: string;
  className: string;
  nodeList: "addedNodes" | "removedNodes";
}) => {
  const blocks = ms.flatMap((m) =>
    Array.from(m[nodeList]).filter(
      (d: Node) =>
        d.nodeName === tag &&
        Array.from((d as HTMLElement).classList).includes(className)
    )
  );
  const childBlocks = ms.flatMap((m) =>
    Array.from(m[nodeList])
      .filter((n) => n.hasChildNodes())
      .flatMap((d) =>
        Array.from((d as HTMLElement).getElementsByClassName(className))
      )
  );
  return [...blocks, ...childBlocks];
};

export const createHTMLObserver = ({
  callback,
  tag,
  className,
  removeCallback,
}: {
  callback: (b: HTMLElement) => void;
  tag: string;
  className: string;
  removeCallback?: (b: HTMLElement) => void;
}): void => {
  const blocks = document.getElementsByClassName(className);
  Array.from(blocks).forEach(callback);

  createObserver((ms) => {
    const addedNodes = getMutatedNodes({
      ms,
      nodeList: "addedNodes",
      tag,
      className,
    });
    addedNodes.forEach(callback);
    if (removeCallback) {
      const removedNodes = getMutatedNodes({
        ms,
        nodeList: "removedNodes",
        tag,
        className,
      });
      removedNodes.forEach(removeCallback);
    }
  });
};

export const createHashtagObserver = ({
  callback,
  attribute,
}: {
  callback: (s: HTMLSpanElement) => void;
  attribute: string;
}): void =>
  createHTMLObserver({
    tag: "SPAN",
    className: "rm-page-ref--tag",
    callback: (s: HTMLSpanElement) => {
      if (!s.getAttribute(attribute)) {
        s.setAttribute(attribute, "true");
        callback(s);
      }
    },
  });

export const getReferenceBlockUid = (e: HTMLElement): string => {
  const parent = e.closest(".roam-block") as HTMLDivElement;
  const { blockUid } = getUids(parent);
  const refs = getChildRefUidsByBlockUid(blockUid);
  const index = Array.from(
    parent.getElementsByClassName("rm-block-ref")
  ).indexOf(e);
  return refs[index];
};

export const createBlockObserver = (
  blockCallback: (b: HTMLDivElement) => void,
  blockRefCallback?: (b: HTMLSpanElement) => void
): void => {
  createHTMLObserver({
    callback: blockCallback,
    tag: "DIV",
    className: "roam-block",
  });
  if (blockRefCallback) {
    createHTMLObserver({
      callback: blockRefCallback,
      tag: "SPAN",
      className: "rm-block-ref",
    });
  }
};

export const createPageObserver = (
  name: string,
  callback: (blockUid: string, added: boolean) => void
): void =>
  createObserver((ms) => {
    const addedNodes = getMutatedNodes({
      ms,
      nodeList: "addedNodes",
      tag: "DIV",
      className: "roam-block",
    }).map((blockNode) => ({
      blockUid: getUids(blockNode as HTMLDivElement).blockUid,
      added: true,
    }));

    const removedNodes = getMutatedNodes({
      ms,
      nodeList: "removedNodes",
      tag: "DIV",
      className: "roam-block",
    }).map((blockNode) => ({
      blockUid: getUids(blockNode as HTMLDivElement).blockUid,
      added: false,
    }));

    if (addedNodes.length || removedNodes.length) {
      const blockUids = getBlockUidsByPageTitle(name);
      [...removedNodes, ...addedNodes]
        .filter(({ blockUid }) => blockUids.has(blockUid))
        .forEach(({ blockUid, added }) => callback(blockUid, added));
    }
  });

export const createButtonObserver = ({
  shortcut,
  attribute,
  render,
}: {
  shortcut: string;
  attribute: string;
  render: (b: HTMLButtonElement) => void;
}): void =>
  createHTMLObserver({
    callback: (b) => {
      if (
        b.innerText.toUpperCase() ===
          attribute.toUpperCase().replace("-", " ") ||
        b.innerText.toUpperCase() === shortcut.toUpperCase()
      ) {
        const dataAttribute = `data-roamjs-${attribute}`;
        if (!b.getAttribute(dataAttribute)) {
          b.setAttribute(dataAttribute, "true");
          render(b as HTMLButtonElement);
        }
      }
    },
    tag: "BUTTON",
    className: "bp3-button",
  });

export const createOverlayObserver = (
  mutationCallback: (mutationList?: MutationRecord[]) => void
): void => createDivObserver(mutationCallback, document.body);

const createDivObserver = (
  mutationCallback: (mutationList?: MutationRecord[]) => void,
  mutationTarget: Element
) => {
  const observer = new MutationObserver(mutationCallback);
  observer.observe(mutationTarget, { childList: true, subtree: true });
};

const POPOVER_WRAPPER_CLASS = "sort-popover-wrapper";

export const createSortIcon = (
  refContainer: HTMLDivElement,
  sortCallbacks: { [key: string]: (refContainer: Element) => () => void }
): HTMLSpanElement => {
  // Icon Button
  const popoverWrapper = document.createElement("span");
  popoverWrapper.className = `bp3-popover-wrapper ${POPOVER_WRAPPER_CLASS}`;

  const popoverTarget = document.createElement("span");
  popoverTarget.className = "bp3-popover-target";
  popoverWrapper.appendChild(popoverTarget);

  const popoverButton = createIconButton("sort");
  popoverTarget.appendChild(popoverButton);

  // Overlay Content
  const popoverOverlay = document.createElement("div");
  popoverOverlay.className = "bp3-overlay bp3-overlay-inline";
  popoverWrapper.appendChild(popoverOverlay);

  const transitionContainer = document.createElement("div");
  transitionContainer.className =
    "bp3-transition-container bp3-popover-enter-done";
  transitionContainer.style.position = "absolute";
  transitionContainer.style.willChange = "transform";
  transitionContainer.style.top = "0";
  transitionContainer.style.left = "0";

  const popover = document.createElement("div");
  popover.className = "bp3-popover";
  popover.style.transformOrigin = "162px top";
  transitionContainer.appendChild(popover);

  const popoverContent = document.createElement("div");
  popoverContent.className = "bp3-popover-content";
  popover.appendChild(popoverContent);

  const menuUl = document.createElement("ul");
  menuUl.className = "bp3-menu";
  popoverContent.appendChild(menuUl);

  let selectedMenuItem: HTMLAnchorElement;
  const createMenuItem = (text: string, sortCallback: () => void) => {
    const liItem = document.createElement("li");
    const aMenuItem = document.createElement("a");
    aMenuItem.className = "bp3-menu-item bp3-popover-dismiss";
    liItem.appendChild(aMenuItem);
    const menuItemText = document.createElement("div");
    menuItemText.className = "bp3-text-overflow-ellipsis bp3-fill";
    menuItemText.innerText = text;
    aMenuItem.appendChild(menuItemText);
    menuUl.appendChild(liItem);
    aMenuItem.onclick = (e) => {
      sortCallback();
      aMenuItem.style.fontWeight = "600";
      if (selectedMenuItem) {
        selectedMenuItem.style.fontWeight = null;
      }
      selectedMenuItem = aMenuItem;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    aMenuItem.onmousedown = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };
  };
  Object.keys(sortCallbacks).forEach((k: keyof typeof sortCallbacks) =>
    createMenuItem(`Sort By ${k}`, sortCallbacks[k](refContainer))
  );

  let popoverOpen = false;
  const documentEventListener = (e: MouseEvent) => {
    if (
      (!e.target || !popoverOverlay.contains(e.target as HTMLElement)) &&
      popoverOpen
    ) {
      closePopover();
    }
  };

  const closePopover = () => {
    popoverOverlay.className = "bp3-overlay bp3-overlay-inline";
    popoverOverlay.removeChild(transitionContainer);
    document.removeEventListener("click", documentEventListener);
    popoverOpen = false;
  };

  popoverButton.onmousedown = (e) => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  popoverButton.onclick = (e) => {
    if (!popoverOpen) {
      const target = e.target as HTMLButtonElement;
      transitionContainer.style.transform = `translate3d(${
        target.offsetLeft <= 240 ? target.offsetLeft : target.offsetLeft - 240
      }px, ${target.offsetTop + 24}px, 0px)`;
      popoverOverlay.className =
        "bp3-overlay bp3-overlay-open bp3-overlay-inline";
      popoverOverlay.appendChild(transitionContainer);
      e.stopImmediatePropagation();
      e.preventDefault();
      document.addEventListener("click", documentEventListener);
      popoverOpen = true;
    } else {
      closePopover();
    }
  };
  return popoverWrapper;
};

// This API is terrible and should be redesigned
export const createSortIcons = (
  containerClass: string,
  callback: (container: HTMLDivElement) => void,
  sortCallbacks: { [key: string]: (refContainer: Element) => () => void },
  childIndex?: number,
  shouldCreate?: (container: HTMLDivElement) => boolean
): void => {
  const sortButtonContainers = Array.from(
    document.getElementsByClassName(containerClass)
  ) as HTMLDivElement[];
  sortButtonContainers.forEach((sortButtonContainer) => {
    const exists =
      sortButtonContainer.getElementsByClassName(POPOVER_WRAPPER_CLASS).length >
      0;
    if (exists) {
      return;
    }

    if (shouldCreate && !shouldCreate(sortButtonContainer)) {
      return;
    }

    const popoverWrapper = createSortIcon(sortButtonContainer, sortCallbacks);
    if (childIndex) {
      const before = sortButtonContainer.children[childIndex];
      sortButtonContainer.insertBefore(popoverWrapper, before);
    } else {
      sortButtonContainer.appendChild(popoverWrapper);
    }

    callback(sortButtonContainer);
  });
};

export const getCreatedTimeByTitle = (title: string): number => {
  const result = window.roamAlphaAPI.q(
    `[:find (pull ?e [:create/time]) :where [?e :node/title "${title.replace(
      /"/g,
      '\\"'
    )}"]]`
  )[0][0] as RoamBlock;
  return result?.time || getEditTimeByTitle(title);
};

export const getEditTimeByTitle = (title: string): number => {
  const result = window.roamAlphaAPI.q(
    `[:find (pull ?e [:edit/time]) :where [?e :node/title "${title.replace(
      /"/g,
      '\\"'
    )}"]]`
  )[0][0] as RoamBlock;
  return result?.time;
};

export const getConfigFromBlock = (
  container: HTMLElement
): { [key: string]: string } => {
  const block = container.closest(".roam-block");
  if (!block) {
    return {};
  }
  const blockId = block.id.substring(block.id.length - 9, block.id.length);

  return getAttrConfigFromQuery(
    `[:find (pull ?e [*]) :where [?e :block/uid "${blockId}"]]`
  );
};

const getWordCount = (str = "") => str.trim().split(/\s+/).length;

const getWordCountByBlockId = (blockId: number): number => {
  const block = window.roamAlphaAPI.pull(
    "[:block/children, :block/string]",
    blockId
  );
  const children = block[":block/children"] || [];
  const count = getWordCount(block[":block/string"]);
  return (
    count +
    children
      .map((c) => getWordCountByBlockId(c[":db/id"]))
      .reduce((total, cur) => cur + total, 0)
  );
};

export const getWordCountByBlockUid = (blockUid: string): number => {
  const block = window.roamAlphaAPI.q(
    `[:find (pull ?e [:block/children, :block/string]) :where [?e :block/uid "${blockUid}"]]`
  )[0][0] as RoamBlock;
  const children = block.children || [];
  const count = getWordCount(block.string);
  return (
    count +
    children
      .map((c) => getWordCountByBlockId(c.id))
      .reduce((total, cur) => cur + total, 0)
  );
};

export const getWordCountByPageTitle = (title: string): number => {
  const page = window.roamAlphaAPI.q(
    `[:find (pull ?e [:block/children]) :where [?e :node/title "${title}"]]`
  )[0][0] as RoamBlock;
  const children = page.children || [];
  return children
    .map((c) => getWordCountByBlockId(c.id))
    .reduce((total, cur) => cur + total, 0);
};

export const getRefTitlesByBlockUid = (uid: string): string[] =>
  window.roamAlphaAPI
    .q(
      `[:find (pull ?r [:node/title]) :where [?e :block/refs ?r] [?e :block/uid "${uid}"]]`
    )
    .map((b: RoamBlock[]) => b[0]?.title || "");

export const getPageTitle = (e: Element): ChildNode => {
  const container =
    e.closest(".roam-log-page") ||
    e.closest(".rm-sidebar-outline") ||
    e.closest(".roam-article") ||
    document;
  const heading =
    (container.getElementsByClassName(
      "rm-title-display"
    )[0] as HTMLHeadingElement) ||
    (container.getElementsByClassName(
      "rm-zoom-item-content"
    )[0] as HTMLSpanElement);
  return Array.from(heading.childNodes).find(
    (n) => n.nodeName === "#text" || n.nodeName === "SPAN"
  );
};

export const getPageUidByPageTitle = (title: string): string => {
  const result = window.roamAlphaAPI.q(
    `[:find (pull ?e [:block/uid]) :where [?e :node/title "${title}"]]`
  );
  if (!result.length) {
    return "";
  }
  const block = result[0][0] as RoamBlock;
  return block.uid;
};

export const getBlockDepthByBlockUid = (blockUid: string): number => {
  const result = window.roamAlphaAPI.q(
    `[:find (pull ?c [:node/title, :block/uid]) :where [?c :block/children ?e] [?e :block/uid "${blockUid}"]]`
  );
  if (!result.length) {
    return -1;
  }
  const block = result[0][0] as RoamBlock;
  return block.title ? 1 : getBlockDepthByBlockUid(block.uid) + 1;
};

const getBlockUidsByBlockId = (blockId: number): string[] => {
  const block = window.roamAlphaAPI.pull(
    "[:block/children, :block/uid]",
    blockId
  );
  const children = block[":block/children"] || [];
  return [
    block[":block/uid"],
    ...children.flatMap((c) => getBlockUidsByBlockId(c[":db/id"])),
  ];
};

const getBlockUidsByPageTitle = (title: string) => {
  const result = window.roamAlphaAPI.q(
    `[:find (pull ?e [:block/children]) :where [?e :node/title "${title}"]]`
  );
  if (!result.length) {
    return new Set();
  }
  const page = result[0][0] as RoamBlock;
  const children = page.children || [];
  return new Set(children.flatMap((c) => getBlockUidsByBlockId(c.id)));
};

export const getLinkedPageReferences = (t: string): RoamBlock[] => {
  const findParentBlock: (b: RoamBlock) => RoamBlock = (b: RoamBlock) =>
    b.title
      ? b
      : findParentBlock(
          window.roamAlphaAPI.q(
            `[:find (pull ?e [*]) :where [?e :block/children ${b.id}]]`
          )[0][0] as RoamBlock
        );
  const parentBlocks = window.roamAlphaAPI
    .q(
      `[:find (pull ?parentPage [*]) :where [?parentPage :block/children ?referencingBlock] [?referencingBlock :block/refs ?referencedPage] [?referencedPage :node/title "${t.replace(
        /"/g,
        '\\"'
      )}"]]`
    )
    .filter((block) => block.length);
  return parentBlocks.map((b) =>
    findParentBlock(b[0] as RoamBlock)
  ) as RoamBlock[];
};

export const getChildRefStringsByBlockUid = (b: string): string[] =>
  window.roamAlphaAPI
    .q(
      `[:find (pull ?r [:block/string]) :where [?e :block/refs ?r] [?e :block/uid "${b}"]]`
    )
    .filter((r) => r.length && r[0])
    .map((r: RoamBlock[]) => r[0].string || "");

export const getChildRefUidsByBlockUid = (b: string): string[] =>
  window.roamAlphaAPI
    .q(
      `[:find (pull ?r [:block/uid]) :where [?e :block/refs ?r] [?e :block/uid "${b}"]]`
    )
    .map((r: RoamBlock[]) => r[0].uid);

export const getNthChildUidByBlockUid = ({
  blockUid,
  order,
}: {
  blockUid: string;
  order: number;
}): string =>
  window.roamAlphaAPI.q(
    `[:find ?u :where [?c :block/uid ?u] [?c :block/order ${order}] [?p :block/children ?c] [?p :block/uid "${blockUid}"]]`
  )?.[0]?.[0] as string;

export const getFirstChildUidByBlockUid = (blockUid: string): string =>
  getNthChildUidByBlockUid({ blockUid, order: 0 });

export const getLinkedReferences = (t: string): RoamBlock[] => {
  const parentBlocks = window.roamAlphaAPI
    .q(
      `[:find (pull ?referencingBlock [*]) :where [?referencingBlock :block/refs ?referencedPage] [?referencedPage :node/title "${t.replace(
        /"/g,
        '\\"'
      )}"]]`
    )
    .filter((block) => block.length);
  return parentBlocks.map((b) => b[0]) as RoamBlock[];
};

export const createMobileIcon = (
  id: string,
  iconType: string
): HTMLButtonElement => {
  const iconButton = document.createElement("button");
  iconButton.id = id;
  iconButton.className =
    "bp3-button bp3-minimal rm-mobile-button dont-unfocus-block";
  iconButton.style.padding = "6px 4px 4px;";
  const icon = document.createElement("i");
  icon.className = `zmdi zmdi-hc-fw-rc zmdi-${iconType}`;
  icon.style.cursor = "pointer";
  icon.style.color = "rgb(92, 112, 128)";
  icon.style.fontSize = "18px";
  icon.style.transform = "scale(1.2)";
  icon.style.fontWeight = "1.8";
  icon.style.margin = "8px 4px";
  iconButton.appendChild(icon);
  return iconButton;
};

export const isApple = isIOS || isMacOs;

export const isControl = (e: KeyboardEvent): boolean => e.ctrlKey;

export const addStyle = (content: string): HTMLStyleElement => {
  const css = document.createElement("style");
  css.textContent = content;
  document.getElementsByTagName("head")[0].appendChild(css);
  return css;
};

export const createCustomSmartBlockCommand = ({
  command,
  processor,
}: {
  command: string;
  processor: (afterColon?: string) => Promise<string>;
}): void => {
  const inputListener = () => {
    if (window.roam42 && window.roam42.smartBlocks) {
      const value = `<%${command.toUpperCase()}(:.*)?%>`;
      window.roam42.smartBlocks.customCommands.push({
        key: `<% ${command.toUpperCase()} %> (SmartBlock function)`,
        icon: "gear",
        processor: (match: string) => {
          const colonPrefix = `<%${command.toUpperCase()}:`;
          if (match.startsWith(colonPrefix)) {
            const afterColon = match.replace("<%${}:", "").replace("%>", "");
            return processor(afterColon);
          } else {
            return processor();
          }
        },
        value,
      });
      document.removeEventListener("input", inputListener);
    }
  };
  document.addEventListener("input", inputListener);
};

export const getRoamUrl = (blockUid: string): string =>
  `${window.location.href.replace(/\/page\/.*$/, "")}/page/${blockUid}`;

const blockRefRegex = new RegExp("\\(\\((..........?)\\)\\)", "g");
const aliasRefRegex = new RegExp(
  `\\[[^\\]]*\\]\\((${blockRefRegex.source})\\)`,
  "g"
);
const aliasTagRegex = new RegExp(
  `\\[[^\\]]*\\]\\((\\[\\[([^\\]]*)\\]\\])\\)`,
  "g"
);
export const resolveRefs = (text: string): string => {
  return text
    .replace(aliasTagRegex, (alias, del, pageName) => {
      const blockUid = getPageUidByPageTitle(pageName);
      return alias.replace(del, `${getRoamUrl(blockUid)}`);
    })
    .replace(aliasRefRegex, (alias, del, blockUid) => {
      return alias.replace(del, `${getRoamUrl(blockUid)}`);
    })
    .replace(blockRefRegex, (_, blockUid) => {
      const reference = getTextByBlockUid(blockUid);
      return reference || blockUid;
    });
};

export const getTitlesReferencingPagesInSameBlockTree = (
  pages: string[]
): string[] => {
  return window.roamAlphaAPI
    .q(
      `[:find ?title ${pages
        .map((_, i) => `(pull ?b${i} [:block/parents, :db/id])`)
        .join(" ")} :where [?e :node/title ?title] ${pages
        .map(
          (p, i) =>
            `[?b${i} :block/page ?e] [?b${i} :block/refs ?d${i}] [?d${i} :node/title "${p}"]`
        )
        .join(" ")}]`
    )
    .filter((r) => {
      const blocks = r.slice(1) as { parents: { id: number }[]; id: number }[];
      if (new Set(blocks.map((b) => b.id)).size === 1) {
        return true;
      }
      const topMostBlock = blocks
        .slice(1)
        .reduce(
          (prev, cur) =>
            cur.parents.length < prev.parents.length ? cur : prev,
          blocks[0]
        );
      return blocks.every(
        (b) =>
          b === topMostBlock ||
          b.parents.some(({ id }) => id === topMostBlock.id)
      );
    })
    .map((r) => r[0] as string);
};

export const getAttributeValueFromPage = ({
  pageName,
  attributeName,
}: {
  pageName: string;
  attributeName: string;
}): string => {
  const blockString = window.roamAlphaAPI.q(
    `[:find ?s :where [?b :block/string ?s] [?r :node/title "${attributeName}"] [?b :block/refs ?r] [?b :block/page ?p] [?p :node/title "${pageName}"]]`
  )?.[0]?.[0] as string;
  return blockString
    ? blockString.match(new RegExp(`${attributeName}::(.*)`))?.[1] || ""
    : "";
};

export const DAILY_NOTE_PAGE_REGEX = /(January|February|March|April|May|June|July|August|September|October|November|December) [0-3]?[0-9](st|nd|rd|th), [0-9][0-9][0-9][0-9]/;
export const TODO_REGEX = /{{\[\[TODO\]\]}}/g;
export const DONE_REGEX = /{{\[\[DONE\]\]}} ?/g;
export const createTagRegex = (tag: string): RegExp =>
  new RegExp(`#?\\[\\[${tag}\\]\\]|#${tag}`, "g");

export const extractTag = (tag: string): string =>
  tag.startsWith("#[[") && tag.endsWith("]]")
    ? tag.substring(3, tag.length - 2)
    : tag.startsWith("[[") && tag.endsWith("]]")
    ? tag.substring(2, tag.length - 2)
    : tag.startsWith("#")
    ? tag.substring(1)
    : tag;
