from unittest import TestCase
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from lyric_pages import find_lyric_page


class LyricPageTests(TestCase):
    def test_uta_net_retries_on_empty_results_and_selects_title_and_artist(self):
        candidates = [{"title": "No match"}, {"title": "風の中は走るっきゃないっ！", "artist": "三月のパンタシア"}]
        page = (
            '<tr><td><a href="/song/10/">風の中は走るっきゃないっ！</a></td><td><a href="/artist/2/">Another artist</a></td></tr>'
            '<tr><td><a href="/song/400252/"><span class="songlist-title">風の中は走るっきゃないっ！</span>'
            '<span>三月のパンタシア</span></a></td><td><a href="/artist/3/">三月のパンタシア</a></td></tr>'
        )
        with patch("lyric_pages.fetch_search", side_effect=["<p>No results</p>", page]) as fetch:
            found = find_lyric_page("uta-net", candidates, None, "OP")
        self.assertEqual(found["url"], "https://www.uta-net.com/song/400252/")
        self.assertEqual(found["tried"], 2)
        self.assertEqual([parse_qs(urlsplit(call.args[0]).query)["keyword"][0] for call in fetch.call_args_list],
                         [candidate["title"] for candidate in candidates])

    def test_utaten_anime_results_distinguish_opening_and_ending(self):
        candidates = [{"title": "生徒会にも穴はある！", "anime": True}]
        page = ('<tr><td><a href="/lyric/mz26100705/">風の中は走るっきゃないっ! (TVアニメのオープニングテーマ)</a></td></tr>'
                '<tr><td><a href="/lyric/sz26100711/">ぴ (TVアニメのエンディングテーマ)</a></td></tr>')
        with patch("lyric_pages.fetch_search", return_value=page):
            found = find_lyric_page("uta-ten", candidates, None, "ED")
        self.assertEqual(found["url"], "https://utaten.com/lyric/sz26100711/")
