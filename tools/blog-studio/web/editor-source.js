import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Markdown } from '@tiptap/markdown';
import { common, createLowlight } from 'lowlight';
import DOMPurify from 'dompurify';
import * as media from '../shared/media.js';
window.StudioMedia = media;
window.StudioEditor = (element, content, onChange, onFiles) => new Editor({
  element,
  extensions: [StarterKit.configure({codeBlock:false, underline:false, link:{openOnClick:false,defaultProtocol:'https'}}),
    TableKit.configure({table:{resizable:false}}), Image, ...media.mediaExtensions(), TaskList, TaskItem.configure({nested:true}),
    CodeBlockLowlight.configure({lowlight:createLowlight(common)}), Markdown],
  content, contentType:'markdown',
  editorProps: {
    attributes: {'aria-label':'글 본문 편집기',role:'textbox','aria-multiline':'true'},
    transformPastedHTML: html => DOMPurify.sanitize(html),
    handlePaste(view,event) {
      const files=Array.from(event.clipboardData?.files||[]);
      if(files.length){onFiles(files);return true;} return false;
    },
    handleDrop(view,event) {
      const files=Array.from(event.dataTransfer?.files||[]);
      if(files.length){event.preventDefault();onFiles(files);return true;} return false;
    }
  },
  onUpdate:onChange
});
