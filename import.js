'use strict';

/* 文件导入：图片 / PDF / Word(docx) —— 全部在本地完成，不联网 */
(function () {
  var FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';
  var PDF_PAGE_MAX = 80;

  function decodeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&amp;/g, '&');
  }

  function loadImage(src) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { rej(new Error('图片解码失败')); };
      img.src = src;
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  /* ---------------- 图片 ---------------- */
  async function imagePages(file) {
    var url = await readAsDataURL(file);
    var img = await loadImage(url);
    var w = img.naturalWidth || 1200;
    var h = img.naturalHeight || 800;
    var MAX = 1800;
    var k = Math.min(1, MAX / Math.max(w, h));
    return [{ w: Math.round(w * k), h: Math.round(h * k), url: url }];
  }

  /* ---------------- PDF ---------------- */
  var SELF_SRC = (function () {
    try {
      if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    } catch (e) { /* ignore */ }
    return location.href;
  })();

  function workerUrl() {
    try { return new URL('vendor/pdf.worker.min.js', SELF_SRC).href; } catch (e) { return 'vendor/pdf.worker.min.js'; }
  }

  async function pdfPages(file, onProgress) {
    if (!window.pdfjsLib) throw new Error('PDF 引擎未加载（vendor/pdf.min.js 缺失）');
    var pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl();
    var buf = await file.arrayBuffer();
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    var total = Math.min(doc.numPages, PDF_PAGE_MAX);
    var out = [];
    for (var i = 1; i <= total; i++) {
      var page = await doc.getPage(i);
      var vp1 = page.getViewport({ scale: 1 });
      var scale = Math.min(2.2, 1600 / vp1.width);
      var vp = page.getViewport({ scale: scale });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push({ w: c.width, h: c.height, url: c.toDataURL('image/jpeg', 0.88) });
      if (onProgress) onProgress(i, total);
    }
    return out;
  }

  /* ---------------- docx：手写 ZIP 解析（浏览器原生解压） ---------------- */
  async function unzip(buf) {
    var u8 = new Uint8Array(buf);
    var dv = new DataView(buf);
    var eocd = -1;
    var stop = Math.max(0, u8.length - 66000);
    for (var i = u8.length - 22; i >= stop; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 .docx 文件');
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var map = new Map();
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true);
      var compSize = dv.getUint32(off + 20, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var commentLen = dv.getUint16(off + 32, true);
      var localOff = dv.getUint32(off + 42, true);
      var name = new TextDecoder('utf-8').decode(u8.subarray(off + 46, off + 46 + nameLen));
      map.set(name, { method: method, compSize: compSize, localOff: localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    async function read(name) {
      var e = map.get(name);
      if (!e) return null;
      var p = e.localOff;
      if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('docx 结构损坏');
      var nl = dv.getUint16(p + 26, true);
      var el = dv.getUint16(p + 28, true);
      var start = p + 30 + nl + el;
      var raw = u8.subarray(start, start + e.compSize);
      if (e.method === 0) return raw;
      if (e.method !== 8) throw new Error('不支持的压缩方式');
      if (typeof DecompressionStream === 'undefined') throw new Error('浏览器过旧，请使用新版 Edge/Chrome');
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([raw]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return { read: read, names: Array.from(map.keys()) };
  }

  function docxParagraphs(xml) {
    var paras = [];
    var pRe = /<w:p(\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
    var m;
    while ((m = pRe.exec(xml))) {
      var body = m[2];
      var sm = /<w:pStyle\s+w:val="([^"]+)"/.exec(body);
      var style = sm ? sm[1] : '';
      var b = body
        .replace(/<w:tab\s*\/>/g, '\t')
        .replace(/<w:br\s*\/>/g, '\n')
        .replace(/<\/w:tc>/g, '\t')
        .replace(/<\/w:tr>/g, '\n')
        .replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, function (_, a, t) { return decodeXml(t); })
        .replace(/<[^>]+>/g, '');
      var text = b.replace(/[ \u00a0]+/g, ' ').trim();
      paras.push({ text: text, style: style });
    }
    return paras;
  }

  function headingSize(style) {
    var s = (style || '').toLowerCase();
    if (s === 'title' || s === '标题') return 40;
    if (s === 'subtitle') return 32;
    if (s === 'heading1' || s === '1' || s === '标题1') return 32;
    if (s === 'heading2' || s === '2' || s === '标题2') return 26;
    if (s === 'heading3' || s === '3' || s === '标题3') return 22;
    return 19;
  }

  function isHeading(style) {
    var s = (style || '').toLowerCase();
    return /title|heading|^[123]$|标题/.test(s);
  }

  function wrapText(ctx, text, maxW) {
    var tokens = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]|[A-Za-z0-9@#$%&*\-_\/=+:;.,!?'"()\[\]{}<>~|]+|[ \t]+/g) || [];
    var lines = [];
    var cur = '';
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var test = cur + t;
      if (ctx.measureText(test).width <= maxW || !cur) {
        cur = test;
      } else {
        lines.push(cur);
        cur = t.replace(/^[ \t]+/, '');
      }
      if (ctx.measureText(cur).width > maxW && cur.length > 1) {
        // 单个超长词强制断行
        while (ctx.measureText(cur).width > maxW && cur.length > 1) {
          var cut = cur.length - 1;
          while (cut > 1 && ctx.measureText(cur.slice(0, cut)).width > maxW) cut--;
          lines.push(cur.slice(0, cut));
          cur = cur.slice(cut);
        }
      }
    }
    if (cur.replace(/\s+$/, '')) lines.push(cur);
    if (!lines.length) lines.push('');
    return lines;
  }

  async function docxPages(file) {
    var buf = await file.arrayBuffer();
    var zip = await unzip(buf);
    var xmlBytes = await zip.read('word/document.xml');
    if (!xmlBytes) throw new Error('docx 中找不到正文');
    var xml = new TextDecoder('utf-8').decode(xmlBytes);
    var paras = docxParagraphs(xml);

    var PW = 1240, PH = 1754, M = 96;
    var canvases = [];
    var cvs, ctx, y;
    function newPage() {
      cvs = document.createElement('canvas');
      cvs.width = PW;
      cvs.height = PH;
      ctx = cvs.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, PW, PH);
      ctx.fillStyle = '#1c2026';
      ctx.textBaseline = 'top';
      y = M;
      canvases.push(cvs);
    }
    newPage();

    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      var size = headingSize(p.style);
      var bold = isHeading(p.style);
      ctx.font = (bold ? 'bold ' : '') + size + 'px ' + FONT;
      var lh = Math.round(size * 1.62);
      var rawLines = p.text ? p.text.split('\n') : [''];
      var lines = [];
      for (var j = 0; j < rawLines.length; j++) {
        var seg = wrapText(ctx, rawLines[j], PW - M * 2);
        for (var k = 0; k < seg.length; k++) lines.push(seg[k]);
      }
      for (var li = 0; li < lines.length; li++) {
        if (y + lh > PH - M) newPage();
        if (lines[li]) ctx.fillText(lines[li], M, y);
        y += lh;
      }
      y += Math.round(size * 0.45);
    }

    return canvases.map(function (c) {
      return { w: PW, h: PH, url: c.toDataURL('image/jpeg', 0.86) };
    });
  }

  window.InkImport = {
    imagePages: imagePages,
    pdfPages: pdfPages,
    docxPages: docxPages,
  };
})();
