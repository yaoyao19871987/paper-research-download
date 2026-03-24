import re
html = open("captcha_slider_dom.html", encoding="utf-8").read()
classes = set(re.findall(r'class=[\"\']([^\"\']+)[\"\']', html))
print(f"Total HTML length: {len(html)}")
print("Classes found:")
for c in classes:
    if len(c) < 50:
        print(f" - {c}")

canvases = re.findall(r'<canvas[^>]*>', html)
print(f"\nCanvases found: {len(canvases)}")
for c in canvases:
    print(c)
