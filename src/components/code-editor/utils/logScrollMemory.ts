import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

// 日志（.log）查看器的滚动行为：
//  1. 默认吸底显示结尾（tail -f）：打开即定位到文件末尾；内容追加时若仍在底部，自动跟随到最新。
//  2. 用户向上滚动浏览历史后，取消「吸底」，不再强制跳到底部；自动刷新（整文档替换）时恢复到之前的浏览位置。
//  3. 按文件路径持久化滚动位置/吸底状态：浏览器刷新后恢复到之前浏览的位置。
//
// 两个易错点（本实现重点防御）：
//  A. 挂载首帧容器高度可能尚未稳定，scrollHeight 偏小 → 一次性 scrollToBottom 会「停在顶部」。
//     对策：挂载初期多帧重新吸底 + 设「初始沉降窗口」忽略布局抖动触发的 scroll 事件。
//  B. .log 自动刷新用 @uiw/react-codemirror 整文档替换，会把滚动位置重置到顶部并触发 scroll 事件，
//     误把 stuck 翻成 false → 之后不再吸底。
//     对策：所有程序化滚动加「时间窗护栏」，期间忽略 scroll 事件；docChanged 后按 stuck 重新到底/恢复位置。

const BOTTOM_THRESHOLD_PX = 40; // 距底 40px 内视为「吸底」，容忍行高/抖动
const PERSIST_DEBOUNCE_MS = 200;
const PROGRAMMATIC_GUARD_MS = 120; // 程序化滚动后忽略 scroll 事件的时间窗
const INITIAL_SETTLE_MS = 250; // 挂载初期布局未稳，忽略自动 scroll 事件的时间窗

type SavedState = { top: number; stuck: boolean };

// v2：升级 key 以丢弃旧实现遗留的脏状态（误存的 {top:0, stuck:false} 会导致永远停在顶部）
const STORAGE_VERSION = 'v2';
const storageKeyFor = (fileKey: string) => `log-scroll:${STORAGE_VERSION}:${fileKey}`;

const readSaved = (fileKey: string): SavedState | null => {
  try {
    const raw = localStorage.getItem(storageKeyFor(fileKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.top === 'number' && typeof parsed.stuck === 'boolean') {
      return parsed as SavedState;
    }
  } catch {
    /* ignore 解析/存储异常 */
  }
  return null;
};

const writeSaved = (fileKey: string, state: SavedState) => {
  try {
    localStorage.setItem(storageKeyFor(fileKey), JSON.stringify(state));
  } catch {
    /* ignore 配额/隐私模式异常 */
  }
};

const isAtBottom = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;

// fileKey：用于持久化的稳定标识（文件绝对路径）。
export function createLogScrollMemoryExtension(fileKey: string): Extension {
  // ViewPlugin 闭包状态：每个编辑器实例（每次挂载/刷新重建）独立。
  // domEventHandlers 与 plugin 共享同一 state 对象。
  const state = {
    stuck: true, // 当前是否吸底跟随
    restored: false, // 是否已完成首次滚动位置恢复
    lastTop: 0, // 最近一次「用户滚动」到达的位置（用于刷新后恢复浏览位置）
    programmaticUntil: 0, // 程序化滚动护栏截止时间戳（此前忽略 scroll 事件）
    saveTimer: 0 as ReturnType<typeof setTimeout> | 0,
  };

  const now = () => Date.now();
  const guardProgrammatic = (ms = PROGRAMMATIC_GUARD_MS) => {
    state.programmaticUntil = Math.max(state.programmaticUntil, now() + ms);
  };
  const inProgrammaticWindow = () => now() < state.programmaticUntil;

  // 所有程序化滚动都先开护栏，避免随后异步触发的 scroll 事件污染 stuck/lastTop。
  const setScrollTop = (view: EditorView, top: number) => {
    guardProgrammatic();
    view.scrollDOM.scrollTop = top;
  };
  const scrollToBottom = (view: EditorView) => setScrollTop(view, view.scrollDOM.scrollHeight);

  const persist = (view: EditorView) => {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      writeSaved(fileKey, { top: view.scrollDOM.scrollTop, stuck: state.stuck });
    }, PERSIST_DEBOUNCE_MS);
  };

  const restore = (view: EditorView) => {
    const saved = readSaved(fileKey);
    if (saved && !saved.stuck) {
      // 之前停在中间浏览历史 → 恢复绝对滚动位置（日志只在末尾追加，顶部偏移稳定）
      state.stuck = false;
      state.lastTop = saved.top;
      setScrollTop(view, saved.top);
    } else {
      // 无记录、或之前吸底 → 默认显示结尾
      state.stuck = true;
      scrollToBottom(view);
    }
    state.restored = true;
  };

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        // 初始沉降窗口：挂载初期布局抖动触发的 scroll 事件一律忽略，避免误判 stuck。
        guardProgrammatic(INITIAL_SETTLE_MS);
        // 首次创建：等布局测量后恢复滚动位置（保证 scrollHeight 已就绪）
        view.requestMeasure({ read: () => null, write: (_m, v) => restore(v) });
        // 容器高度可能在随后几帧才稳定 → 多次重新吸底，修复「打开停在顶部」（易错点 A）
        requestAnimationFrame(() =>
          view.requestMeasure({
            read: () => null,
            write: (_m, v) => {
              if (state.stuck) scrollToBottom(v);
            },
          }),
        );
        setTimeout(() =>
          view.requestMeasure({
            read: () => null,
            write: (_m, v) => {
              if (state.stuck) scrollToBottom(v);
            },
          }),
        INITIAL_SETTLE_MS);
      }

      update(update: ViewUpdate) {
        if (!state.restored || !update.docChanged) return;
        // 自动刷新整文档替换会把滚动位置重置到顶部（易错点 B）：
        //   吸底 → 重新到底；非吸底 → 恢复用户刷新前的浏览位置。
        const targetTop = state.stuck ? null : state.lastTop;
        guardProgrammatic(); // 同步开护栏，覆盖整文档替换引发的回顶 scroll 事件
        update.view.requestMeasure({
          read: () => null,
          write: (_m, v) => {
            v.scrollDOM.scrollTop = targetTop == null ? v.scrollDOM.scrollHeight : targetTop;
          },
        });
      }

      destroy() {
        if (state.saveTimer) clearTimeout(state.saveTimer);
      }
    },
  );

  return [
    plugin,
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        // 完成首次恢复前、或处于程序化滚动护栏窗口内 → 忽略，避免把
        //（恢复中的中间态 / 整文档替换回顶 / 初期布局抖动）误判为用户滚动并覆盖状态。
        if (!state.restored) return;
        if (inProgrammaticWindow()) return;
        state.stuck = isAtBottom(view.scrollDOM);
        state.lastTop = view.scrollDOM.scrollTop;
        persist(view);
      },
    }),
  ];
}
