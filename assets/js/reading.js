/**
 * 文章页增强：阅读进度条、目录跟随高亮、代码块语言标签。
 * 纯渐进增强：脚本不执行时页面与原来完全一致。
 */
(function () {
    'use strict';

    /* ── 1. 阅读进度条 ───────────────────────────────────────── */
    var content = document.querySelector('.post-content');
    var fill = null;
    var bar = null;
    if (content) {
        bar = document.createElement('div');
        bar.className = 'reading-progress';
        bar.setAttribute('role', 'presentation');
        fill = document.createElement('span');
        bar.appendChild(fill);
        document.body.appendChild(bar);
    }

    /* ── 2. 目录跟随高亮 ─────────────────────────────────────── */
    var tocItems = [];
    Array.prototype.forEach.call(document.querySelectorAll('.toc a[href^="#"]'), function (link) {
        var target = document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
        if (target) tocItems.push({ link: link, el: target });
    });
    var activeLink = null;

    function syncToc() {
        if (!tocItems.length) return;
        var line = window.scrollY + 140;
        var current = tocItems[0];
        for (var i = 0; i < tocItems.length; i++) {
            if (tocItems[i].el.getBoundingClientRect().top + window.scrollY <= line) {
                current = tocItems[i];
            } else {
                break;
            }
        }
        if (current.link !== activeLink) {
            if (activeLink) activeLink.classList.remove('is-active');
            current.link.classList.add('is-active');
            activeLink = current.link;
        }
    }

    /* ── 3. 滚动统一处理（rAF 节流） ─────────────────────────── */
    var ticking = false;

    function onScroll() {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
            ticking = false;
            if (fill) {
                var total = document.documentElement.scrollHeight - window.innerHeight;
                var pct = total > 0 ? (window.scrollY / total) * 100 : 0;
                fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
                bar.classList.toggle('is-visible', window.scrollY > 60);
            }
            syncToc();
        });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();

    /* ── 4. 代码块语言标签 ───────────────────────────────────── */
    Array.prototype.forEach.call(document.querySelectorAll('.md-content div.highlight'), function (block) {
        var pre = block.firstElementChild;
        if (!pre || pre.tagName !== 'PRE') return; // 带行号的表格结构不处理，避免破坏布局
        var code = pre.firstElementChild;
        if (!code || code.tagName !== 'CODE') return;

        var matched = /(?:^|\s)language-([^\s]+)/.exec(code.className);
        if (!matched) return;
        var lang = matched[1].toLowerCase();
        // 没写语言标记的代码块 Hugo 会标成 text，显示成「TEXT」没有意义
        if (lang === 'text' || lang === 'plain' || lang === 'plaintext' || lang === 'fallback') {
            lang = '文本';
        }

        var head = document.createElement('div');
        head.className = 'code-head';
        var label = document.createElement('span');
        label.className = 'code-lang';
        label.textContent = lang;
        head.appendChild(label);
        block.insertBefore(head, block.firstChild);
    });
})();
