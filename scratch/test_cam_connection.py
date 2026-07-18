import cv2
import os
import time

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "tls_verify;0;stimeout;2000000;rtsp_transport;tcp"

ips = ["192.168.0.242", "192.168.0.243", "192.168.0.244", "192.168.0.245"]
passwords = ["Gateway@123", "password", "admin", "admin123", "admin1234"]
paths = [
    "/video/live?channel=1&subtype=1&unicast=true&proto=Onvif",
    "/cam/realmonitor?channel=1&subtype=1",
    "/live",
    "/VideoInput/1/mpeg4/1",
    "/onvif1"
]
protocols = ["rtsp", "rtsps"]

print("=== Starting camera connectivity probe ===")

for ip in ips:
    print(f"\nProbing IP: {ip}...")
    found = False
    for password in passwords:
        if found:
            break
        # URL encode password for safety
        encoded_pass = password.replace("@", "%40")
        for path in paths:
            if found:
                break
            for proto in protocols:
                url = f"{proto}://admin:{encoded_pass}@{ip}:554{path}"
                print(f"  Trying: {url}")
                try:
                    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
                    if cap.isOpened():
                        ret, frame = cap.read()
                        if ret:
                            print(f"  [SUCCESS] Connected to {ip} using {url}!")
                            found = True
                            cap.release()
                            break
                    cap.release()
                except Exception as e:
                    pass
    if not found:
        print(f"  [FAILED] Could not connect to {ip} with any combination.")
