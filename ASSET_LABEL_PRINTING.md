# Asset Label Printing Feature - Implementation Guide

## Overview

This feature enables admins to print QR code and barcode labels for assets (statpacks, inventory items) in PDF format. Labels are fully customizable with configurable dimensions for different printers and vinyl sheets.

## Architecture

### Client-Side PDF Generation
- **Approach**: Option A (html2canvas + jsPDF)
- **Why**: Compatible with Next.js static export, consistent rendering, good for vinyl/paper printing
- **Libraries**:
  - `qrcode` (QR code generation)
  - `jsbarcode` (Code128 barcode generation)
  - `html2canvas` (DOM-to-canvas rendering)
  - `jspdf` (PDF assembly)

### Files Created

1. **[app/components/label-card.tsx](app/components/label-card.tsx)**
   - Reusable label component
   - Renders QR code (60x60px), barcode (code128), asset name, category
   - Sized in mm with DPI conversion for accurate printing
   - Supports both InventoryItem and Statpack types

2. **[app/styles/print-labels.css](app/styles/print-labels.css)**
   - Print-optimized CSS with mm-based layout
   - CSS variables for customization
   - Print media queries for browser printing
   - Responsive preview mode

3. **[app/lib/print.ts](app/lib/print.ts)**
   - PDF export utility functions
   - Template management (save/load to localStorage)
   - Label-per-page calculations
   - `exportLabelsToPDF()` main export function

4. **[app/print-labels/page.tsx](app/print-labels/page.tsx)**
   - Admin-only print route (`/print-labels`)
   - Fetches assets by ID from Firestore
   - Live preview with template customization
   - PDF export and browser print options
   - Template persistence

### Files Modified

1. **[app/assets/page.tsx](app/assets/page.tsx)**
   - Added checkbox column for multi-select
   - Print button in header (shows when items selected)
   - Uses localStorage to pass selected IDs to print route

2. **[app/components/assetmodal.tsx](app/components/assetmodal.tsx)**
   - Added "PDF" button next to existing "Print" button
   - `printTagPDF()` function for single-asset PDF export
   - Reuses QR/barcode generation logic

3. **[package.json](package.json)**
   - Added `html2canvas@^1.4.1` dependency

## Usage Workflows

### Multi-Asset Printing (Bulk)

1. Navigate to `/assets` (admin only)
2. Check boxes next to assets to print
3. Click "Print (N)" button in header
4. Redirected to `/print-labels` with selected asset IDs
5. Customize template settings (dimensions, gaps, margins)
6. Preview labels arranged in pages
7. Click "Export as PDF" → downloads `asset-labels.pdf`

### Single-Asset Printing

1. Open asset in AssetModal (click Edit)
2. Generate/verify QR code and barcode
3. Click "PDF" button
4. Downloads single-label PDF

### Template Customization

**Default Template (A5 page)**:
- Page: 148 × 210 mm
- Margins: 8 mm (all sides)
- Label: 48 × 30 mm
- Gaps: H=4mm, V=4mm
- ~6 labels per page (2 cols × 3 rows)

**Custom Templates**:
- Adjust dimensions in UI
- Click "Save Template" to persist locally
- Load saved templates from dropdown
- Delete templates with trash icon

## Technical Details

### PDF Generation Flow

1. User selects assets and opens `/print-labels`
2. Page fetches asset data from Firestore (`inventory`, `statpacks` collections)
3. Renders `<LabelCard>` components (QR + barcode + text)
4. On "Export PDF":
   - Each label rendered to canvas via `html2canvas`
   - Canvas images added to `jsPDF` at exact mm coordinates
   - Pages auto-paginated based on labels-per-page
   - PDF downloaded to browser

### Barcode/QR Content

- **QR Code**: `assetSerial` or `qr` field or `name`
- **Barcode**: Same as QR (Code128 format)
- **Text**: Asset name (truncated to 15 chars), category

### Role Access

- **Admin**: full access (multi-select, bulk print, template save)
- **Other roles**: redirected to dashboard

### Print Quality

- **DPI**: Default 96 (screen), 2x scale for canvas (192 effective)
- **Format**: PNG images embedded in PDF
- **Vinyl compatibility**: Labels are mm-accurate; test on target printer

## Testing Checklist

- [ ] Navigate to `/assets` as admin
- [ ] Select 2-3 assets via checkboxes
- [ ] Print button appears with count
- [ ] Click Print → redirects to `/print-labels`
- [ ] Assets load and display in preview
- [ ] Template controls update layout in real-time
- [ ] Labels-per-page calculation updates correctly
- [ ] "Export as PDF" downloads valid PDF
- [ ] PDF opens and contains correct QR/barcode/text
- [ ] Print PDF on target printer/vinyl → verify alignment
- [ ] Open AssetModal → click PDF button → single-asset PDF downloads
- [ ] Save template → reload page → load template → settings restored

## Deployment Notes

- **Static export compatible**: All logic runs client-side
- **No server-side dependencies**: Works with Firebase Hosting
- **Storage**: Templates saved to browser localStorage (per-device)
- **Build**: Run `npm run build` then `npx next export` (if needed)

## Future Enhancements

- **Option B (Vector PDF)**: Draw QR/barcodes directly to PDF canvas for smaller file size and crisper output
- **Batch size limits**: Add chunking for 100+ labels to prevent memory issues
- **Print calibration**: Add test page with ruler markings for alignment
- **Cloud template storage**: Save templates to Firestore for org-wide sharing
- **Advanced layouts**: Support for Avery label templates, custom multi-column grids

## Troubleshooting

**PDF is blank or images missing**:
- Check browser console for CORS errors
- Ensure QR/barcode generation completes before export
- Try refreshing page and re-exporting

**Labels misaligned on printer**:
- Verify printer page size matches template (A5, Letter, etc.)
- Adjust margins and gaps in template
- Print calibration page to measure actual vs expected

**"No labels to export" error**:
- Ensure assets were selected and IDs passed to route
- Check localStorage for `printAssetIds` key
- Verify assets exist in Firestore

**Performance issues with large batches**:
- Limit to <20 labels per export
- Increase browser memory if possible
- Consider server-side PDF generation (requires backend)

## Support

For questions or issues, check:
- [Implementation summary](IMPLEMENTATION_COMPLETE.md)
- [Asset management guide](ASSET_MANAGEMENT_GUIDE.md)
- Code comments in [app/lib/print.ts](app/lib/print.ts) and [app/print-labels/page.tsx](app/print-labels/page.tsx)
