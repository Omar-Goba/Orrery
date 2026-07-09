from backend.services.summarize import _parse_model_result, front_matter_text


def test_front_matter_text_stops_at_references() -> None:
    text = "Title\n\nAbstract content\nReferences\nUnrelated citation text"

    assert front_matter_text(text) == "Title\n\nAbstract content"


def test_parse_model_result_accepts_valid_json() -> None:
    result = _parse_model_result(
        '{"title":"Paper Title","author_last":"Smith","year":"2024",'
        '"summary":"This paper proposes a concrete clustering method for research libraries."}',
        "openai",
    )

    assert result is not None
    assert result.title == "Paper Title"
    assert result.author_last == "Smith"
    assert result.year == "2024"
    assert result.summary is not None
    assert result.source == "openai"


def test_parse_model_result_rejects_generic_summary() -> None:
    result = _parse_model_result(
        '{"title":"Paper Title","author_last":"Smith","year":"2024",'
        '"summary":"This paper discusses."}',
        "openai",
    )

    assert result is None
