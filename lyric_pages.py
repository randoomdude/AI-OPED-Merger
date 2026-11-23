"""Find public song pages using each lyric site's search results."""
from html.parser import HTMLParser
import re
from time import monotonic
from unicodedata import normalize
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


SITES = {
    "uta-net": ("https://www.uta-net.com", r"/song/\d+/"),
    "uta-ten": ("https://utaten.com", r"/lyric/[a-z]+\d+/"),
}


class SearchRows(HTMLParser):
    def __init__(self, pattern):
        super().__init__()
        self.pattern = pattern
        self.rows = []
        self.row = None
        self.anchor = None
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr":
            self.row = {}
        elif self.row is not None and tag == "a":
            path = urlsplit(attrs.get("href", "")).path
            if re.fullmatch(self.pattern, path) or path.startswith("/artist/"):
                self.anchor = (path, [], [])
                self.in_title = False
        elif self.anchor and tag == "span" and "songlist-title" in attrs.get("class", "").split():
            self.in_title = True

    def handle_data(self, data):
        if self.anchor:
            self.anchor[1].append(data)
            if self.in_title:
                self.anchor[2].append(data)

    def handle_endtag(self, tag):
        if tag == "span":
            self.in_title = False
        elif tag == "a" and self.row is not None and self.anchor:
            path, full, title = self.anchor
            self.row.setdefault(path, "".join(title or full).strip())
            self.anchor = None
        elif tag == "tr" and self.row is not None:
            artist = next((title for path, title in self.row.items() if path.startswith("/artist/")), "")
            self.rows.extend((path, title, artist) for path, title in self.row.items() if re.fullmatch(self.pattern, path))
            self.row = self.anchor = None


def title_key(text):
    return "".join(char for char in normalize("NFKC", text).casefold() if char.isalnum())


def search_url(site, term):
    if site == "uta-net":
        params = {"target": "tieup" if term["anime"] else "title", "type": "in", "keyword": term["title"]}
        return SITES[site][0] + "/search/?" + urlencode(params)
    params = {"sub_title" if term["anime"] else "title": term["title"], "sort": "popular_sort_asc"}
    if term["artist"]:
        params["artist_name"] = term["artist"]
    return SITES[site][0] + "/search?" + urlencode(params)


def fetch_search(url, timeout):
    domain = urlsplit(url).netloc

    class SameSite(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, new_url):
            target = urlsplit(new_url)
            if target.scheme != "https" or target.netloc != domain:
                raise URLError("Search redirected away from the lyric site")
            return super().redirect_request(request, fp, code, msg, headers, new_url)

    request = Request(url, headers={
        "Accept": "text/html",
        "User-Agent": "AI-OPED-Merger (https://github.com/randoomdude/AI-OPED-Merger)",
    })
    with build_opener(SameSite()).open(request, timeout=timeout) as response:
        return response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")


def find_lyric_page(site, candidates, theme, slot):
    if site not in SITES or not isinstance(candidates, list) or slot not in ("OP", "ED"):
        raise ValueError("Choose Uta-Net or UtaTen.")
    homepage, pattern = SITES[site]
    role = r"オープニング|\b(?:opening|op)\b" if slot == "OP" else r"エンディング|\b(?:ending|ed)\b"
    end = monotonic() + 18
    checked = set()
    unavailable = False
    suggestions = {}
    for candidate in candidates[:12]:
        time_left = end - monotonic()
        if time_left <= 0:
            unavailable = True
            break
        if not isinstance(candidate, dict):
            continue
        term = {"title": str(candidate.get("title") or "").strip()[:200],
                "artist": str(candidate.get("artist") or "").strip()[:120],
                "anime": candidate.get("anime") is True}
        expected = theme if term["anime"] else term
        if not term["title"]:
            continue
        url = search_url(site, term)
        if url in checked:
            continue
        checked.add(url)
        try:
            parser = SearchRows(pattern)
            parser.feed(fetch_search(url, min(time_left, 5)))
        except HTTPError as error:
            unavailable = True
            if error.code in (401, 403, 429, 503):
                break
            continue
        except (OSError, ValueError):
            unavailable = True
            continue
        title = title_key(str((expected or {}).get("title") or ""))
        artist = title_key(str((expected or {}).get("artist") or ""))
        matches = {}
        for path, song, author in parser.rows:
            name = re.sub(r"\s*[（(](?:TV)?アニメ.*$", "", song)
            if not name:
                continue
            exact = title and title_key(name) == title and (not artist or title_key(author) == artist)
            tagged = expected is None and name != song and re.search(role, song[len(name):], re.I)
            if exact or tagged:
                matches.setdefault(path, name)
            if term["anime"] and expected is None and len(suggestions) < 5:
                suggestions.setdefault(path, {"url": homepage + path, "title": name, "artist": author})
        if len(matches) == 1:
            path, title = next(iter(matches.items()))
            return {"url": homepage + path, "title": title, "tried": len(checked)}
    return {"url": "", "tried": len(checked), "unavailable": unavailable, "suggestions": list(suggestions.values())}
