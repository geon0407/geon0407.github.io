// Video nodes shared by both Blog Studio editors (Codespaces web/ and browser webapp/).
// In Markdown they are stored as one-line HTML blocks, which kramdown passes through to the page:
//   <div class="video-embed video-file"><video src="/uploads/…mp4" controls preload="metadata" playsinline></video></div>
//   <div class="video-embed youtube"><iframe src="https://www.youtube-nocookie.com/embed/ID" …></iframe></div>
import {Node} from '@tiptap/core';

export const VIDEO_EXTENSIONS = ['.mp4', '.webm'];
export const VIDEO_LIMIT = 50 * 1024 * 1024;
export const isVideoFile = name => VIDEO_EXTENSIONS.some(ext => String(name).toLowerCase().endsWith(ext));

const attr = value => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Accepts watch / youtu.be / shorts / live / embed links or a bare 11-character id.
export function youtubeId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

// "t=90", "t=1m30s", "start=90" → seconds.
export function youtubeStart(input) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch { return 0; }
  const value = url.searchParams.get('start') || url.searchParams.get('t') || '';
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!match) return 0;
  return (+match[1] || 0) * 3600 + (+match[2] || 0) * 60 + (+match[3] || 0);
}

export const youtubeSrc = ({videoId, start}) => `https://www.youtube-nocookie.com/embed/${videoId}${start ? `?start=${start}` : ''}`;
const IFRAME = 'title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"';
// reframe-off: the blog's reframe.js would otherwise re-wrap the iframe; .video-embed sizes it.
export const youtubeHtml = attrs => `<div class="video-embed youtube"><iframe class="reframe-off" src="${attr(youtubeSrc(attrs))}" ${IFRAME}></iframe></div>`;
export const videoHtml = src => `<div class="video-embed video-file"><video src="${attr(src)}" controls preload="metadata" playsinline></video></div>`;

// resolveSrc(src) → Promise<url>: lets the browser Studio show videos that only exist privately.
export function mediaExtensions({resolveSrc = null} = {}) {
  const Video = Node.create({
    name: 'video',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() { return {src: {default: null}}; },
    parseHTML() {
      return [
        {tag: 'video[src]', getAttrs: el => ({src: el.getAttribute('src')})},
        {tag: 'video', getAttrs: el => (el.querySelector('source[src]') ? {src: el.querySelector('source[src]').getAttribute('src')} : false)},
      ];
    },
    renderHTML({node}) {
      return ['div', {class: 'video-embed video-file'}, ['video', {src: node.attrs.src, controls: '', preload: 'metadata', playsinline: ''}]];
    },
    renderMarkdown: node => videoHtml(node.attrs?.src || ''),
    addNodeView() {
      if (!resolveSrc) return null;
      return ({node}) => {
        const dom = document.createElement('div');
        dom.className = 'video-embed video-file';
        const video = document.createElement('video');
        Object.assign(video, {controls: true, preload: 'metadata', playsInline: true});
        dom.append(video);
        const apply = current => {
          const src = current.attrs.src || '';
          video.dataset.src = src;
          resolveSrc(src).then(resolved => { if (video.dataset.src === src) video.src = resolved; });
        };
        apply(node);
        return {
          dom,
          update(next) { if (next.type.name !== 'video') return false; apply(next); return true; },
          ignoreMutation: () => true,
        };
      };
    },
    addCommands() {
      // Insert after the current selection, so a selected video is not replaced.
      return {setVideo: src => ({state, commands}) => commands.insertContentAt(state.selection.to, {type: this.name, attrs: {src}})};
    },
  });

  const YouTube = Node.create({
    name: 'youtube',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() { return {videoId: {default: null}, start: {default: 0}}; },
    parseHTML() {
      return [{
        tag: 'iframe[src]',
        getAttrs: el => {
          const src = el.getAttribute('src');
          const videoId = youtubeId(src);
          return videoId ? {videoId, start: youtubeStart(src)} : false;
        },
      }];
    },
    renderHTML({node}) {
      return ['div', {class: 'video-embed youtube'}, ['iframe', {
        class: 'reframe-off', src: youtubeSrc(node.attrs), title: 'YouTube video player', frameborder: '0', allowfullscreen: 'true', loading: 'lazy',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
        referrerpolicy: 'strict-origin-when-cross-origin',
      }]];
    },
    renderMarkdown: node => youtubeHtml(node.attrs || {}),
    addCommands() {
      return {setYoutube: attrs => ({state, commands}) => commands.insertContentAt(state.selection.to, {type: this.name, attrs})};
    },
  });

  return [Video, YouTube];
}
