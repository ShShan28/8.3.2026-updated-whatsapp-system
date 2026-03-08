# server.py - Backend API for dynamic watermarking (Python/Flask)
from flask import Flask, request, jsonify
from io import BytesIO
import base64
import os
import re

# Libraries for Watermarking
from PIL import Image, ImageDraw, ImageFont  # For Images
from pypdf import PdfReader, PdfWriter       # PDF handling
from reportlab.pdfgen import canvas          # For creating PDF watermarks
from reportlab.lib.pagesizes import A4       # Use standard page sizes
from reportlab.lib.colors import gray
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Initialize Flask App
app = Flask(__name__)

# --- Configuration ---
from flask_cors import CORS
CORS(app)

# NEW: Health Check Route to prevent 404 errors during startup
@app.route('/', methods=['GET'])
def health_check():
    return jsonify({
        "status": "online", 
        "message": "Watermark Server is Ready",
        "version": "Enterprise 4.0"
    }), 200

# Configure font paths (you may need to adjust these for your system)
try:
    # Try to register a proper font if available
    pdfmetrics.registerFont(TTFont('Arial', 'arial.ttf'))
    pdfmetrics.registerFont(TTFont('Arial-Bold', 'arialbd.ttf'))
except:
    print("Warning: Custom fonts not found, using default")

FONT_PATH = "arial.ttf" if os.path.exists("arial.ttf") else None
# ---------------------

# --- Helper Functions ---

def validate_watermark_text(watermark_text):
    """Validate and format the watermark text into two lines."""
    # Remove extra spaces and split by comma or other delimiters
    watermark_text = watermark_text.strip()
    
    # Try to detect phone number patterns
    phone_patterns = [
        r'\(\d{3}\) \d{3}-\d{4}',  # (123) 456-7890
        r'\d{3}-\d{3}-\d{4}',      # 123-456-7890
        r'\d{10}',                  # 1234567890
        r'\+\d{1,3} \d{3} \d{3} \d{4}',  # +1 234 567 8901
        r'\d{3} \d{3} \d{4}',      # 123 456 7890
    ]
    
    # Check if text contains a phone number
    has_phone = any(re.search(pattern, watermark_text) for pattern in phone_patterns)
    
    # If there's a clear separator like comma or pipe, split by it
    if ',' in watermark_text:
        parts = [part.strip() for part in watermark_text.split(',', 1)]
        if len(parts) == 2:
            return parts[:2]
    elif '|' in watermark_text:
        parts = [part.strip() for part in watermark_text.split('|', 1)]
        if len(parts) == 2:
            return parts[:2]
    
    # If we have a phone number but no clear separator, try to split intelligently
    if has_phone:
        # Look for common separators or split after name
        for sep in [' - ', ' at ', ' : ', ' \n', ' ']:
            if sep in watermark_text:
                parts = [part.strip() for part in watermark_text.split(sep, 1)]
                if len(parts) == 2:
                    return parts[:2]
        
        # If text contains digits, try to separate name and phone
        match = re.search(r'(\D+)(\d[\d\s\-\(\)\.]+)', watermark_text)
        if match:
            name = match.group(1).strip()
            phone = match.group(2).strip()
            return [name, phone]
    
    # Default: put text on first line, empty second line
    return [watermark_text, ""]

def create_watermark_text(raw_text):
    """Create properly formatted two-line watermark text."""
    text_lines = validate_watermark_text(raw_text)
    
    # Ensure we have exactly 2 lines
    if len(text_lines) < 2:
        text_lines.append("")
    elif len(text_lines) > 2:
        text_lines = text_lines[:2]
    
    return text_lines

# Function to apply watermark to Images (SINGLE, CENTERED, TWO-LINE)
def watermark_image(binary_data, text_lines):
    """Applies a single, two-line, centered, semi-transparent watermark to an image."""
    try:
        # 1. Open the original image
        img = Image.open(BytesIO(binary_data)).convert("RGBA")
        width, height = img.size
        
        # Determine font size (relative to image size)
        # Use smaller of width or height to determine font size
        min_dimension = min(width, height)
        font_size = max(24, int(min_dimension / 25))  # Minimum 24px
        
        try:
            if FONT_PATH and os.path.exists(FONT_PATH):
                font = ImageFont.truetype(FONT_PATH, font_size)
            else:
                # Try different font paths
                font_paths = [
                    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                    "/System/Library/Fonts/Helvetica.ttc",
                    "C:/Windows/Fonts/arial.ttf",
                ]
                for fp in font_paths:
                    if os.path.exists(fp):
                        font = ImageFont.truetype(fp, font_size)
                        break
                else:
                    font = ImageFont.load_default()
        except:
            font = ImageFont.load_default()
        
        # Create a temporary draw object to measure text
        temp_draw = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
        
        # Calculate text block size for both lines
        text_bboxes = []
        for line in text_lines:
            bbox = temp_draw.textbbox((0, 0), line, font=font)
            text_bboxes.append(bbox)
        
        text_widths = [bbox[2] - bbox[0] for bbox in text_bboxes]
        text_heights = [bbox[3] - bbox[1] for bbox in text_bboxes]
        
        max_text_width = max(text_widths)
        line_height = max(text_heights)
        line_spacing = line_height * 0.3  # Space between lines
        total_text_height = (line_height * 2) + line_spacing
        
        # 2. Create a transparent layer
        watermark_layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(watermark_layer)
        
        # 3. Define Watermark properties
        # Light gray with 40% opacity (alpha=102 out of 255)
        fill_color = (128, 128, 128, 102)
        
        # 4. Calculate Center Position for each line
        x_positions = [(width - w) // 2 for w in text_widths]
        y_center = height // 2
        
        # Position lines centered vertically
        y1 = y_center - (total_text_height // 2)
        y2 = y1 + line_height + line_spacing
        
        # 5. Draw the text with shadow effect for better visibility
        shadow_color = (0, 0, 0, 30)  # Very subtle black shadow
        
        # Draw shadow (slightly offset)
        shadow_offset = 1
        draw.text((x_positions[0] + shadow_offset, y1 + shadow_offset), 
                  text_lines[0], font=font, fill=shadow_color)
        draw.text((x_positions[1] + shadow_offset, y2 + shadow_offset), 
                  text_lines[1], font=font, fill=shadow_color)
        
        # Draw main text
        draw.text((x_positions[0], y1), text_lines[0], font=font, fill=fill_color)
        draw.text((x_positions[1], y2), text_lines[1], font=font, fill=fill_color)
        
        # 6. Merge the watermark layer onto the original image
        img = Image.alpha_composite(img, watermark_layer)
        
        # 7. Save the modified image to a buffer
        output = BytesIO()
        
        # Preserve original format if possible
        try:
            format = img.format or 'JPEG'
            if format.upper() == 'PNG':
                img.save(output, format='PNG', optimize=True)
            else:
                img = img.convert("RGB")
                img.save(output, format='JPEG', quality=85, optimize=True)
        except:
            img = img.convert("RGB")
            img.save(output, format='JPEG', quality=85)
            
        output.seek(0)
        return output.read()
        
    except Exception as e:
        print(f"Image Watermarking Error: {e}")
        import traceback
        traceback.print_exc()
        return binary_data

# Function to apply watermark to PDFs (SINGLE, CENTERED, TWO-LINE, UNSELECTABLE)
def watermark_pdf(binary_data, text_lines):
    """Applies a single, two-line, centered, unselectable watermark to each page of a PDF."""
    try:
        # 1. Create the watermark PDF (Overlay)
        watermark_buffer = BytesIO()
        c = canvas.Canvas(watermark_buffer, pagesize=A4)
        
        # Set color and opacity (FIXED OPACITY)
        # Alpha 0.4 = 40% opacity (Visible but transparent)
        c.setFillColorRGB(0.5, 0.5, 0.5, alpha=0.15)
        
        # Use larger font size for PDFs
        font_size = 40
        try:
            c.setFont("Helvetica-Bold", font_size)
        except:
            c.setFont("Helvetica-Bold", font_size)  # Fallback to default
        
        width, height = A4
        
        # Calculate text widths
        text_width_1 = c.stringWidth(text_lines[0], "Helvetica-Bold", font_size)
        text_width_2 = c.stringWidth(text_lines[1], "Helvetica-Bold", font_size)
        max_text_width = max(text_width_1, text_width_2)
        
        # Center the text block horizontally and vertically
        x_pos = (width - max_text_width) / 2
        center_y = height / 2
        line_spacing = font_size * 1.2  # Space between lines
        
        # Calculate line positions to center the block vertically
        total_height = (font_size * 2) + line_spacing
        y1 = center_y + (line_spacing / 2)
        y2 = center_y - (line_spacing / 2)
        
        # Draw the text
        c.drawString(x_pos + (max_text_width - text_width_1) / 2, y1, text_lines[0])
        c.drawString(x_pos + (max_text_width - text_width_2) / 2, y2, text_lines[1])
        
        c.save()
        watermark_buffer.seek(0)
        watermark_pdf = PdfReader(watermark_buffer)

        # 2. Merge the watermark into the original PDF
        original_pdf = PdfReader(BytesIO(binary_data))
        writer = PdfWriter()
        watermark_page = watermark_pdf.pages[0]

        for page_num in range(len(original_pdf.pages)):
            page = original_pdf.pages[page_num]
            
            # Get the actual page size
            page_width = float(page.mediabox.width)
            page_height = float(page.mediabox.height)
            
            # If page size differs from A4, we need to scale the watermark
            if page_width != width or page_height != height:
                # Create scaled watermark for this specific page
                scaled_buffer = BytesIO()
                c_scaled = canvas.Canvas(scaled_buffer, pagesize=(page_width, page_height))
                c_scaled.setFillColorRGB(0.5, 0.5, 0.5, alpha=0.15)
                c_scaled.setFont("Helvetica-Bold", font_size)
                
                # Recalculate positions for this page size
                text_width_1_scaled = c_scaled.stringWidth(text_lines[0], "Helvetica-Bold", font_size)
                text_width_2_scaled = c_scaled.stringWidth(text_lines[1], "Helvetica-Bold", font_size)
                max_text_width_scaled = max(text_width_1_scaled, text_width_2_scaled)
                
                x_pos_scaled = (page_width - max_text_width_scaled) / 2
                center_y_scaled = page_height / 2
                
                c_scaled.drawString(x_pos_scaled + (max_text_width_scaled - text_width_1_scaled) / 2, 
                                   center_y_scaled + (line_spacing / 2), 
                                   text_lines[0])
                c_scaled.drawString(x_pos_scaled + (max_text_width_scaled - text_width_2_scaled) / 2, 
                                   center_y_scaled - (line_spacing / 2), 
                                   text_lines[1])
                
                c_scaled.save()
                scaled_buffer.seek(0)
                watermark_page = PdfReader(scaled_buffer).pages[0]
            
            # Merge with over=True places the unselectable watermark above the original content
            page.merge_page(watermark_page, over=True)
            writer.add_page(page)

        # 3. Save the modified PDF to an output buffer
        output_buffer = BytesIO()
        writer.write(output_buffer)
        output_buffer.seek(0)
        return output_buffer.read()
        
    except Exception as e:
        print(f"PDF Watermarking Error: {e}")
        import traceback
        traceback.print_exc()
        raise

# --- API Endpoint ---

@app.route('/api/watermark_file', methods=['POST'])
def watermark_file():
    data = request.get_json()
    
    if data is None:
        return jsonify({'error': 'Malformed or missing JSON payload in request body.'}), 400
        
    if 'document_base64' not in data or 'file_type' not in data or 'watermark_text' not in data:
        return jsonify({'error': 'Missing document_base64, file_type, or watermark_text fields.'}), 400

    try:
        base64_data = data['document_base64']
        file_type = data['file_type']
        raw_watermark_text = data['watermark_text']
        
        # Create properly formatted two-line watermark text
        text_lines = create_watermark_text(raw_watermark_text)
        
        binary_data = base64.b64decode(base64_data)
        modified_binary_data = None

        if 'image' in file_type.lower():
            modified_binary_data = watermark_image(binary_data, text_lines)
        elif 'pdf' in file_type.lower():
            modified_binary_data = watermark_pdf(binary_data, text_lines)
        else:
            return jsonify({'error': f'Unsupported file type: {file_type}'}), 400

        if modified_binary_data:
            watermarked_base64 = base64.b64encode(modified_binary_data).decode('utf-8')
            print(f"Watermark applied successfully: {text_lines[0]} | {text_lines[1]}")
            return jsonify({
                'watermarked_base64': watermarked_base64,
                'watermark_lines': text_lines
            })
        
        return jsonify({'error': 'Processing failed: Output is empty.'}), 500

    except Exception as e:
        print(f"API Processing Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Server failed to process the file: {str(e)}'}), 500

@app.route('/api/test', methods=['GET'])
def test_endpoint():
    return jsonify({
        'status': 'Server is running',
        'endpoints': {
            'watermark': '/api/watermark_file (POST)',
            'test': '/api/test (GET)'
        }
    })

if __name__ == '__main__':
    print("Starting Watermark API on http://127.0.0.1:5000")
    print("Test endpoint: http://127.0.0.1:5000/api/test")
    app.run(host='0.0.0.0', port=5000, debug=True)