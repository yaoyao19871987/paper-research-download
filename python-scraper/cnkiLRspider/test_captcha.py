import cv2
import numpy as np
import sys
import glob

def debug_captcha(image_path):
    print(f"\n--- Analyzing {image_path} ---")
    img = cv2.imread(image_path)
    if img is None:
        print("Could not read image.")
        return
    
    h, w = img.shape[:2]
    print(f"Size: {w}x{h}")
    
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        # Typical CNKI slider piece is around 40-60 pixels
        if 30 < w < 80 and 30 < h < 80 and area > 500:
            candidates.append((x, y, w, h, area))
    
    candidates.sort(key=lambda x: x[0])
    for cand in candidates:
        print(f"Candidate gap found at x={cand[0]}, y={cand[1]}, w={cand[2]}, h={cand[3]}, area={cand[4]:.1f}")
        
if __name__ == "__main__":
    import glob
    for p in glob.glob("captcha*.png"):
        debug_captcha(p)
