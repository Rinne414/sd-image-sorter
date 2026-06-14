"""Print the actual Smart Tag purpose policy against representative tags."""
import sys
from pathlib import Path

# Add backend to path
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.smart_tag_service import filter_tags_by_training_purpose


def print_section(title: str):
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)


def verify_filtering():
    # Sample tags from a typical anime image
    general_tags = [
        "1girl",
        "blue_eyes",
        "long_hair",
        "smile",
        "outdoors",
        "forest",
        "sunlight",
        "standing",
        "purple_hair",
        "lineart",
    ]

    copyright_tags = [
        "genshin_impact",
        "honkai_star_rail",
    ]

    character_tags = [
        "raiden_shogun",
        "firefly_(honkai_star_rail)",
    ]

    print_section("INPUT TAGS")
    print(f"General tags ({len(general_tags)}):")
    print(f"  {', '.join(general_tags)}")
    print(f"\nCopyright tags ({len(copyright_tags)}):")
    print(f"  {', '.join(copyright_tags)}")
    print(f"\nCharacter tags ({len(character_tags)}):")
    print(f"  {', '.join(character_tags)}")

    # Test each training purpose
    purposes = ["general", "style", "character", "concept"]

    for purpose in purposes:
        trigger = "my_character" if purpose == "character" else ""
        result = filter_tags_by_training_purpose(
            purpose,
            general_tags,
            copyright_tags,
            character_tags,
            trigger_word=trigger,
        )

        print_section(f"TRAINING PURPOSE: {purpose.upper()}")

        if purpose == "style":
            print("Removes identifiable style/artist tags; preserves content context.")
        elif purpose == "character":
            print("With a trigger word, removes detected character-name tags only.")
        else:
            print("Preserves detected context tags.")

        print(f"\nFiltered tags ({len(result)}):")
        print(f"  {', '.join(result)}")

        if purpose == "style":
            assert "lineart" not in result
            assert all(tag in result for tag in copyright_tags + character_tags)
        elif purpose == "character":
            assert all(tag not in result for tag in character_tags)
            assert all(tag in result for tag in copyright_tags)
        else:
            assert all(tag in result for tag in general_tags + copyright_tags + character_tags)

        print("  Policy check passed")

    print_section("VERIFICATION COMPLETE")
    print("All training-purpose policies produced the expected output.")
    print("Official trainer docs define caption mechanics, not a universal purpose filter table.")
    print()


if __name__ == "__main__":
    verify_filtering()
