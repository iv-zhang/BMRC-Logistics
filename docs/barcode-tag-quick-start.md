# Barcode Tag Assignment - Quick Start Guide

## What is this?

Scan purchased asset tags (with pre-printed barcodes) and assign them to your inventory assets. If tags wear off, you can reassign new ones while keeping full history.

## Who can use this?

- ✅ Admins
- ✅ Quartermasters  
- ✅ Inventory Helpers
- ❌ FTOs and Members (view-only)

## How to assign a tag

### Method 1: From Asset Details

1. Go to **Assets** page → Click asset name
2. Scroll to **"External Asset Tag"** section
3. Click **"Scan Tag"** button
4. Use camera or upload image to scan barcode
5. Click **"Assign to Asset"**
6. Done! ✅

### Method 2: Quick-Assign from Assets List

1. Go to **Assets** page
2. Find your asset in the table
3. Click the **📦 Package icon** button
4. Scan the barcode
5. Click **"Assign to Asset"**
6. Done! ✅

## What if the barcode is already used?

You'll see a warning:
```
⚠️ Duplicate Barcode
This barcode is already assigned to [Asset Name]
```

**Options:**
- **"Assign Anyway"** - Override and assign it (both assets will have same barcode)
- **"Cancel"** - Stop and choose a different barcode

## Replacing a worn-off tag

Just scan the new barcode and assign it! The system automatically:
- Saves the old barcode in history
- Sets the new barcode as current
- Records who made the change and when

## Where can I see the history?

Open the asset → Scroll to **"External Asset Tag"** section → See **"Assignment History"**

Or check **Asset History** section for all barcode events.

## Tips

- ✅ One barcode can be assigned to multiple assets (with warning)
- ✅ History is preserved forever (audit trail)
- ✅ Works on desktop and mobile browsers
- ✅ Supports camera scanning and image upload
- ✅ Code128, QR, and UPC barcodes supported

## Troubleshooting

**Scanner won't open?**
- Allow camera permissions in your browser
- Try uploading an image of the barcode instead

**Assignment not saving?**
- Make sure you're logged in
- Check that you have admin/quartermaster/inventory_helper role
- Refresh the page and try again

**Can't find the button?**
- Only inventory assets support external tags (not statpacks yet)
- Make sure the asset is already saved (not a new asset being created)

## Questions?

Ask your admin or check the full documentation: `EXTERNAL_BARCODE_TAG_ASSIGNMENT.md`
