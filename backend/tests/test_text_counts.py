"""English counts in backend messages say the singular for exactly one."""

from text_counts import count_text


def test_one_takes_the_singular():
    assert count_text(1, "image") == "1 image"
    assert count_text("1", "disguise image") == "1 disguise image"


def test_other_counts_take_the_plural():
    assert count_text(0, "image") == "0 images"
    assert count_text(3, "image") == "3 images"
    assert count_text("1,000", "image") == "1,000 images"


def test_an_irregular_plural_is_given():
    assert count_text(2, "entry", "entries") == "2 entries"
    assert count_text(1, "entry", "entries") == "1 entry"
