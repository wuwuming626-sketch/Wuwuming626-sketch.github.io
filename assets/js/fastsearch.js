// 覆盖主题自带的 fastsearch.js：在搜索结果里额外展示命中片段与所属栏目。
// 索引字段见 layouts/_default/index.json。
import * as params from '@params';

let fuse; // holds our search engine
let resList = document.getElementById('searchResults');
let sInput = document.getElementById('searchInput');
let first, last, current_elem = null
let resultsAvailable = false;

// 命中位置前后各保留多少字符作为片段
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;
const FALLBACK_SNIPPET_LEN = 120;
const MAX_MARKS = 5;

// load our search index
window.onload = function () {
    let xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            if (xhr.status === 200) {
                let data = JSON.parse(xhr.responseText);
                if (data) {
                    // fuse.js options; check fuse.js website for details
                    let options = {
                        distance: 100,
                        threshold: 0.4,
                        ignoreLocation: true,
                        includeMatches: true, // 渲染命中片段需要匹配位置
                        keys: [
                            'title',
                            'permalink',
                            'summary',
                            'content',
                            'compact'
                        ]
                    };
                    if (params.fuseOpts) {
                        options = {
                            isCaseSensitive: params.fuseOpts.iscasesensitive ?? false,
                            includeScore: params.fuseOpts.includescore ?? false,
                            includeMatches: true,
                            minMatchCharLength: params.fuseOpts.minmatchcharlength ?? 1,
                            shouldSort: params.fuseOpts.shouldsort ?? true,
                            findAllMatches: params.fuseOpts.findallmatches ?? false,
                            keys: params.fuseOpts.keys ?? ['title', 'permalink', 'summary', 'content', 'compact'],
                            location: params.fuseOpts.location ?? 0,
                            threshold: params.fuseOpts.threshold ?? 0.4,
                            distance: params.fuseOpts.distance ?? 100,
                            ignoreLocation: params.fuseOpts.ignorelocation ?? true
                        }
                    }
                    fuse = new Fuse(data, options); // build the index from the json file
                }
            } else {
                console.log(xhr.responseText);
            }
        }
    };
    xhr.open('GET', "../index.json");
    xhr.send();
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripTags(html) {
    return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 去掉空白字符，并记下每个字符在原文中的下标
function compactize(text) {
    const map = [];
    let out = '';
    for (let i = 0; i < text.length; i++) {
        if (!/\s/.test(text[i])) {
            out += text[i];
            map.push(i);
        }
    }
    return { text: out, map: map };
}

// 忽略空白与大小写的精确定位：返回 [起始下标, 结束下标]（含端点）
// 正文里多写成「U 盘」而用户输入「U盘」时，靠它才能标到正确位置
function findRange(text, query) {
    const q = String(query).replace(/\s+/g, '').toLowerCase();
    if (!q || !text) return null;
    const compact = compactize(text);
    const at = compact.text.toLowerCase().indexOf(q);
    if (at < 0) return null;
    return [compact.map[at], compact.map[at + q.length - 1]];
}

// 相邻（如「U 盘」中间隔一个空格）的命中合并成一段
function mergeHits(hits, gap) {
    const merged = [];
    hits.forEach(function (hit) {
        const last = merged[merged.length - 1];
        if (last && hit[0] - last[1] <= gap) {
            last[1] = Math.max(last[1], hit[1]);
        } else {
            merged.push(hit.slice());
        }
    });
    return merged;
}

// 精确命中找不到时才用：Fuse 给出的模糊命中位置
function fuzzyHits(item, matches) {
    const content = item.content || '';
    if (!content || !matches) return [];
    let hits = [];
    const byContent = matches.find(m => m.key === 'content');
    if (byContent && byContent.indices && byContent.indices.length) {
        hits = byContent.indices.map(i => i.slice());
    } else {
        const byCompact = matches.find(m => m.key === 'compact');
        if (byCompact && byCompact.indices && byCompact.indices.length) {
            const compact = compactize(content);
            hits = byCompact.indices
                .map(i => [compact.map[i[0]], compact.map[i[1]]])
                .filter(i => i[0] !== undefined && i[1] !== undefined);
        }
    }
    hits = mergeHits(hits.sort((a, b) => a[0] - b[0]), 1);
    // 多字查询里单个字母的模糊命中是噪声（搜「U盘」会命中 update 里的 u）
    const meaningful = hits.filter(h => h[1] > h[0]);
    return (meaningful.length ? meaningful : hits).slice(0, MAX_MARKS);
}

// 按原文下标把命中部分包成 <mark>，返回可直接插入的 HTML
function highlight(text, hits, offset) {
    let html = '';
    let pos = 0;
    hits.forEach(function (hit) {
        const s = hit[0] - offset;
        const e = hit[1] - offset;
        if (s < pos || e < s || s >= text.length) return;
        html += escapeHtml(text.slice(pos, s))
            + '<mark>' + escapeHtml(text.slice(s, e + 1)) + '</mark>';
        pos = e + 1;
    });
    return html + escapeHtml(text.slice(pos));
}

function buildSnippet(item, query, matches) {
    const content = item.content || '';
    const exact = findRange(content, query);
    let hits;
    let start;
    let end;
    if (exact) {
        hits = [exact];
        start = Math.max(0, exact[0] - SNIPPET_BEFORE);
        end = Math.min(content.length, exact[1] + 1 + SNIPPET_AFTER);
    } else {
        hits = fuzzyHits(item, matches);
        if (!hits.length) {
            // 只有标题命中时，退化成摘要
            const text = stripTags(item.summary || '');
            if (!text) return '';
            return escapeHtml(text.slice(0, FALLBACK_SNIPPET_LEN))
                + (text.length > FALLBACK_SNIPPET_LEN ? '…' : '');
        }
        // 只围绕第一处命中截取，避免命中散布全文时把整篇正文都塞进片段
        start = Math.max(0, hits[0][0] - SNIPPET_BEFORE);
        end = Math.min(content.length, hits[0][1] + 1 + SNIPPET_AFTER);
        hits = hits.filter(h => h[0] >= start && h[1] < end);
    }
    return (start > 0 ? '…' : '')
        + highlight(content.slice(start, end), hits, start)
        + (end < content.length ? '…' : '');
}

function buildTitle(item, query, matches) {
    const exact = findRange(item.title, query);
    let hits = exact ? [exact] : [];
    if (!hits.length) {
        const titleMatch = (matches || []).find(m => m.key === 'title');
        if (titleMatch && titleMatch.indices) hits = titleMatch.indices;
    }
    return hits.length ? highlight(item.title, hits, 0) : escapeHtml(item.title);
}

function buildResultItem(result, query) {
    const item = result.item;
    const matches = result.matches || [];
    const title = buildTitle(item, query, matches);
    const snippet = buildSnippet(item, query, matches);
    const section = item.section
        ? '<footer class="entry-footer"><span class="entry-section">' + escapeHtml(item.section) + '</span></footer>'
        : '';
    // 带上关键词，文章页据此滚动到正文中的命中位置并高亮
    const href = item.permalink + '#hl=' + encodeURIComponent(query);
    return '<li class="post-entry">'
        + '<header class="entry-header">' + title + '</header>'
        + (snippet ? '<div class="entry-content"><p>' + snippet + '</p></div>' : '')
        + section
        + '<a class="entry-link" href="' + escapeHtml(href)
        + '" aria-label="' + escapeHtml(item.title) + '"></a>'
        + '</li>';
}

function activeToggle(ae) {
    document.querySelectorAll('.focus').forEach(function (element) {
        // rm focus class
        element.classList.remove("focus")
    });
    if (ae) {
        ae.focus()
        document.activeElement = current_elem = ae;
        ae.parentElement.classList.add("focus")
    } else {
        document.activeElement.parentElement.classList.add("focus")
    }
}

function reset() {
    resultsAvailable = false;
    resList.innerHTML = sInput.value = ''; // clear inputbox and searchResults
    sInput.focus(); // shift focus to input box
}

// execute search as each character is typed
sInput.onkeyup = function (e) {
    // run a search query (for "term") every time a letter is typed
    // in the search box
    if (fuse) {
        const query = this.value.trim();
        if (!query) {
            resultsAvailable = false;
            resList.innerHTML = '';
            return;
        }
        let results;
        if (params.fuseOpts) {
            results = fuse.search(query, {limit: params.fuseOpts.limit}); // the actual query being run using fuse.js along with options
        } else {
            results = fuse.search(query); // the actual query being run using fuse.js
        }
        if (results.length !== 0) {
            // build our html if result exists
            let resultSet = ''; // our results bucket

            for (let item in results) {
                resultSet += buildResultItem(results[item], query);
            }

            resList.innerHTML = resultSet;
            resultsAvailable = true;
            first = resList.firstChild;
            last = resList.lastChild;
        } else {
            resultsAvailable = false;
            resList.innerHTML = '<li class="search-empty">没有找到相关文章，换个关键词试试。</li>';
        }
    }
}

sInput.addEventListener('search', function (e) {
    // clicked on x
    if (!this.value) reset()
})

// kb bindings
document.onkeydown = function (e) {
    let key = e.key;
    let ae = document.activeElement;

    let inbox = document.getElementById("searchbox").contains(ae)

    if (ae === sInput) {
        let elements = document.getElementsByClassName('focus');
        while (elements.length > 0) {
            elements[0].classList.remove('focus');
        }
    } else if (current_elem) ae = current_elem;

    if (key === "Escape") {
        reset()
    } else if (!resultsAvailable || !inbox) {
        return
    } else if (key === "ArrowDown") {
        e.preventDefault();
        if (ae == sInput) {
            // if the currently focused element is the search input, focus the <a> of first <li>
            activeToggle(resList.firstChild.lastChild);
        } else if (ae.parentElement != last) {
            // if the currently focused element's parent is last, do nothing
            // otherwise select the next search result
            activeToggle(ae.parentElement.nextSibling.lastChild);
        }
    } else if (key === "ArrowUp") {
        e.preventDefault();
        if (ae.parentElement == first) {
            // if the currently focused element is first item, go to input box
            activeToggle(sInput);
        } else if (ae != sInput) {
            // if the currently focused element is input box, do nothing
            // otherwise select the previous search result
            activeToggle(ae.parentElement.previousSibling.lastChild);
        }
    } else if (key === "ArrowRight") {
        ae.click(); // click on active link
    }
}
