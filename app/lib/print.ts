import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

export interface PrintTemplate {
  pageWidth: number; // mm
  pageHeight: number; // mm
  marginTop: number; // mm
  marginRight: number; // mm
  marginBottom: number; // mm
  marginLeft: number; // mm
  labelWidth: number; // mm
  labelHeight: number; // mm
  horizontalGap: number; // mm
  verticalGap: number; // mm
  labelsPerRow?: number; // auto-calculated if not provided
}

export const DEFAULT_TEMPLATE: PrintTemplate = {
  pageWidth: 148,
  pageHeight: 210,
  marginTop: 8,
  marginRight: 8,
  marginBottom: 8,
  marginLeft: 8,
  labelWidth: 48,
  labelHeight: 30,
  horizontalGap: 4,
  verticalGap: 4,
};

/**
 * Exchange bag labels are taller than the default asset/statpack label —
 * name + a multi-line "Contains: ..." BOM line + QR, no barcode. Same page
 * geometry as `DEFAULT_TEMPLATE`, just a taller label cell.
 */
export const BAG_LABEL_TEMPLATE: PrintTemplate = {
  pageWidth: 148,
  pageHeight: 210,
  marginTop: 8,
  marginRight: 8,
  marginBottom: 8,
  marginLeft: 8,
  labelWidth: 48,
  labelHeight: 50,
  horizontalGap: 4,
  verticalGap: 4,
};

/**
 * Calculate how many labels fit per row based on page and label dimensions
 */
export function calculateLabelsPerRow(template: PrintTemplate): number {
  const availableWidth = template.pageWidth - template.marginLeft - template.marginRight;
  const labelWithGap = template.labelWidth + template.horizontalGap;
  return Math.floor(availableWidth / labelWithGap);
}

/**
 * Calculate how many labels fit per page
 */
export function calculateLabelsPerPage(template: PrintTemplate): number {
  const labelsPerRow = calculateLabelsPerRow(template);
  const availableHeight = template.pageHeight - template.marginTop - template.marginBottom;
  const labelWithGap = template.labelHeight + template.verticalGap;
  const labelsPerColumn = Math.floor(availableHeight / labelWithGap);
  return labelsPerRow * labelsPerColumn;
}

/**
 * Export labels as PDF
 * @param labelElements - array of DOM elements to render as labels
 * @param template - print template configuration
 * @param filename - output filename
 */
export async function exportLabelsToPDF(
  labelElements: HTMLElement[],
  template: PrintTemplate = DEFAULT_TEMPLATE,
  filename: string = 'labels.pdf'
): Promise<void> {
  if (labelElements.length === 0) {
    throw new Error('No labels to export');
  }

  try {
    // Create PDF in mm units
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [template.pageWidth, template.pageHeight],
    });

    const labelsPerRow = calculateLabelsPerRow(template);
    const labelsPerPage = calculateLabelsPerPage(template);
    let labelIndex = 0;

    for (const element of labelElements) {
      // Measure on-screen element to preserve aspect ratio
      const rect = element.getBoundingClientRect();
      const bboxWidth = Math.max(1, Math.round(rect.width));
      const bboxHeight = Math.max(1, Math.round(rect.height));

      // Choose a scale for html2canvas. Use devicePixelRatio or 2 for better quality.
      const scale = typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(2, window.devicePixelRatio) : 2;

      // Render element to canvas at the measured size and scale to avoid CSS unit mismatches
      const canvas = await html2canvas(element, {
        scale,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        width: bboxWidth,
        height: bboxHeight,
      });

      const imgData = canvas.toDataURL('image/png');

      const imgWidth = template.labelWidth; // mm in PDF units
      const imgHeight = template.labelHeight;

      // Calculate position on current page
      const positionInPage = labelIndex % labelsPerPage;
      const rowInPage = Math.floor(positionInPage / labelsPerRow);
      const colInPage = positionInPage % labelsPerRow;

      const x = template.marginLeft + colInPage * (template.labelWidth + template.horizontalGap);
      const y = template.marginTop + rowInPage * (template.labelHeight + template.verticalGap);

      // Add new page if needed
      if (labelIndex > 0 && positionInPage === 0) {
        pdf.addPage([template.pageWidth, template.pageHeight]);
      }

      // Add image to PDF at the mm dimensions we want
      pdf.addImage(imgData, 'PNG', x, y, imgWidth, imgHeight);

      labelIndex++;
    }

    // Download PDF
    pdf.save(filename);
  } catch (error) {
    console.error('Failed to export labels to PDF:', error);
    throw error;
  }
}

/**
 * Generate a print preview by creating a paginated HTML view
 * @param labelElements - array of DOM elements to arrange
 * @param template - print template configuration
 * @returns total number of pages needed
 */
export function generatePrintPreview(
  labelElements: HTMLElement[],
  template: PrintTemplate = DEFAULT_TEMPLATE
): number {
  const labelsPerPage = calculateLabelsPerPage(template);
  const totalPages = Math.ceil(labelElements.length / labelsPerPage);
  return totalPages;
}

/**
 * Save template to localStorage for later use
 */
export function saveTemplate(name: string, template: PrintTemplate): void {
  try {
    const templates = JSON.parse(localStorage.getItem('printTemplates') || '{}');
    templates[name] = template;
    localStorage.setItem('printTemplates', JSON.stringify(templates));
  } catch (error) {
    console.error('Failed to save template:', error);
  }
}

/**
 * Load template from localStorage
 */
export function loadTemplate(name: string): PrintTemplate | null {
  try {
    const templates = JSON.parse(localStorage.getItem('printTemplates') || '{}');
    return templates[name] || null;
  } catch (error) {
    console.error('Failed to load template:', error);
    return null;
  }
}

/**
 * Get all saved templates from localStorage
 */
export function getSavedTemplates(): Record<string, PrintTemplate> {
  try {
    return JSON.parse(localStorage.getItem('printTemplates') || '{}');
  } catch (error) {
    console.error('Failed to get templates:', error);
    return {};
  }
}

/**
 * Delete a saved template from localStorage
 */
export function deleteTemplate(name: string): void {
  try {
    const templates = JSON.parse(localStorage.getItem('printTemplates') || '{}');
    delete templates[name];
    localStorage.setItem('printTemplates', JSON.stringify(templates));
  } catch (error) {
    console.error('Failed to delete template:', error);
  }
}
