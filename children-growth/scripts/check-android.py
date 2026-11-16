"""Static V7 Android checks for environments without Android SDK/JDK tooling."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
JAVA = ANDROID / "app/src/main/java/family/ourkids/app"
ASSETS = ANDROID / "app/src/main/assets/www"
errors = []

def require(path, text, label):
    actual = path.read_text(encoding="utf-8")
    if text not in actual:
        errors.append(f"{label}: missing {text}")
    return actual

for name in ["home.html", "age.html", "story.html", "search.html", "upload.html", "card.html", "index.html", "spec.html"]:
    if not (ASSETS / name).is_file():
        errors.append(f"asset missing: {name}")

entities = require(JAVA / "data/Entities.kt", "@Entity(tableName = \"people\")", "entities")
for table in ["people", "media", "stories", "story_media"]:
    if f'tableName = "{table}"' not in entities:
        errors.append(f"entities: missing table {table}")
require(JAVA / "data/AppDatabase.kt", "Seed.ensure(it)", "seed")
require(JAVA / "data/AppDatabase.kt", 'if (db.storyDao().count() > 0) return', "seed idempotency")
api = require(JAVA / "net/ApiServer.kt", "class ApiServer", "api server")
for route in [
    '"/api/bootstrap"', '"/api/drafts"', '"/api/drafts/accept-all"',
    '"/api/stories"', '"/api/people"', '"/api/today"', '"/accept"', '"/rename"'
]:
    if route not in api:
        errors.append(f"api route missing: {route}")
activity = require(JAVA / "MainActivity.kt", "class MainActivity", "activity")
for marker in [
    "WebViewAssetLoader", "shouldInterceptRequest", "mediaPlaybackRequiresUserGesture = true",
    "onShowFileChooser", "DownloadManager", "shouldOverrideUrlLoading", "handleBack"
]:
    if marker not in activity:
        errors.append(f"activity behavior missing: {marker}")

# Published assets must not contain credentials or local absolute paths.
for path in ASSETS.glob("*.html"):
    text = path.read_text(encoding="utf-8")
    for pattern in [r"X-Amz-Signature", r"Bearer\s+[A-Za-z0-9._-]{12,}", r"file:///", r"[A-Za-z]:[\\/]Users[\\/]"]:
        if re.search(pattern, text, re.I):
            errors.append(f"public asset forbidden string: {path.name}: {pattern}")

if errors:
    print("Android static checks failed")
    print("\n".join(f"  - {e}" for e in errors))
    sys.exit(1)
print("Android static checks passed: assets, Room schema/seed, API routes, shell behavior, and public-asset hygiene")
