// Same editor as the Codespaces Studio, plus an image node view that can show
// uploads that only exist in the private data repo (resolved to blob: URLs).
// The document keeps the original /uploads/... src, so the saved Markdown is unchanged.
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {TableKit} from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {Markdown} from '@tiptap/markdown';
import {common, createLowlight} from 'lowlight';
import DOMPurify from 'dompurify';

export function createEditor(element, content, onChange, onFiles, resolveImage) {
  const StudioImage = Image.extend({
    addNodeView() {
      return ({node}) => {
        const img = document.createElement('img');
        const apply = current => {
          const src = current.attrs.src || '';
          img.alt = current.attrs.alt || '';
          if (current.attrs.title) img.title = current.attrs.title;
          img.dataset.src = src;
          resolveImage(src).then(resolved => { if (img.dataset.src === src) img.src = resolved; });
        };
        apply(node);
        return {
          dom: img,
          update(next) {
            if (next.type.name !== 'image') return false;
            apply(next);
            return true;
          },
          ignoreMutation: () => true,
        };
      };
    },
  });
  return new Editor({
    element,
    extensions: [StarterKit.configure({codeBlock: false, underline: false, link: {openOnClick: false, defaultProtocol: 'https'}}),
      TableKit.configure({table: {resizable: false}}), StudioImage, TaskList, TaskItem.configure({nested: true}),
      CodeBlockLowlight.configure({lowlight: createLowlight(common)}), Markdown],
    content, contentType: 'markdown',
    editorProps: {
      attributes: {'aria-label': '글 본문 편집기', role: 'textbox', 'aria-multiline': 'true'},
      transformPastedHTML: html => DOMPurify.sanitize(html),
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.length) { onFiles(files); return true; }
        return false;
      },
      handleDrop(view, event) {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) { event.preventDefault(); onFiles(files); return true; }
        return false;
      },
    },
    onUpdate: onChange,
  });
}
