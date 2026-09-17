// 从搜索结果点进来时（链接形如 .../post/#hl=关键词），滚动到正文中的命中位置并高亮。
// 关键词匹配忽略空白与大小写，所以搜「U盘」也能定位到正文里的「U 盘」。
(function () {
    var PREFIX = '#hl=';
    if (window.location.hash.indexOf(PREFIX) !== 0) return;

    var query;
    try {
        query = decodeURIComponent(window.location.hash.slice(PREFIX.length));
    } catch (e) {
        query = window.location.hash.slice(PREFIX.length);
    }
    var key = query.replace(/\s+/g, '').toLowerCase();
    if (!key) return;

    var content = document.querySelector('.md-content');
    if (!content) return;

    var nodes = [];
    var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
        var node = walker.currentNode;
        if (!node.nodeValue || !/\S/.test(node.nodeValue)) continue;
        var tag = node.parentNode && node.parentNode.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') continue;
        nodes.push(node);
    }
    if (!nodes.length) return;

    // 去掉空白字符，并记下每个字符在原文中的下标
    function compactize(text) {
        var map = [];
        var out = '';
        for (var i = 0; i < text.length; i++) {
            if (!/\s/.test(text[i])) {
                out += text[i];
                map.push(i);
            }
        }
        return { text: out, map: map };
    }

    // 把文本节点的 [from, to] 段替换成 <mark>
    function markRange(node, from, to) {
        var target = node;
        if (from > 0) target = target.splitText(from);
        // splitText 之后 target 已是后半段，长度判断要用相对长度
        var len = to - from + 1;
        if (len < target.nodeValue.length) target.splitText(len);
        var mark = document.createElement('mark');
        mark.className = 'search-hit';
        target.parentNode.insertBefore(mark, target);
        mark.appendChild(target);
        return mark;
    }

    function reveal(mark) {
        // 等图片、字体加载完再滚动，避免位置偏移
        window.setTimeout(function () {
            mark.scrollIntoView({ block: 'center' });
        }, 60);
    }

    // 1) 命中落在单个文本节点内
    for (var i = 0; i < nodes.length; i++) {
        var info = compactize(nodes[i].nodeValue);
        var at = info.text.toLowerCase().indexOf(key);
        if (at >= 0) {
            reveal(markRange(nodes[i], info.map[at], info.map[at + key.length - 1]));
            return;
        }
    }

    // 2) 命中跨节点（正文里被加粗、链接切开的词）：拼起来找，再落回起始节点
    var joined = '';
    var spans = [];
    nodes.forEach(function (node) {
        var info = compactize(node.nodeValue);
        if (!info.text) return;
        spans.push({ node: node, start: joined.length, text: info.text, map: info.map });
        joined += info.text;
    });
    var at = joined.toLowerCase().indexOf(key);
    if (at < 0) return;
    var span = null;
    for (var j = 0; j < spans.length; j++) {
        if (spans[j].start <= at) span = spans[j];
        else break;
    }
    if (!span) return;
    var localStart = at - span.start;
    var localEnd = Math.min(span.text.length - 1, localStart + key.length - 1);
    reveal(markRange(span.node, span.map[localStart], span.map[localEnd]));
})();
