// server.js

const express = require('express');
const multer = require('multer');
const path = require('path');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const stream = require('stream');
const fs = require('fs-extra');
const helmet = require('helmet');
const winston = require('winston');

const app = express();

// Middleware setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(helmet());

// Configure Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

// Multer configuration for in-memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const filetypes = /csv/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only CSV files are allowed!'));
    },
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Route to render the upload form
app.get('/', (req, res) => {
    res.render('index', { error: null, message: null });
});

// Route to handle CSV upload and transaction generation
app.post('/generate', upload.single('productPrices'), async (req, res) => {
    const { supplierId, specifiedYear } = req.body;
    const file = req.file;

    // Input validations
    if (!file) {
        logger.error('No file uploaded.');
        return res.render('index', { error: 'Please upload a valid CSV file.', message: null });
    }

    if (!supplierId || !specifiedYear) {
        logger.error('Supplier ID or Specified Year missing.');
        return res.render('index', { error: 'Supplier ID and Specified Year are required.', message: null });
    }

    try {
        // Load product prices from uploaded CSV buffer
        const productPrices = await loadProductPricesFromBuffer(file.buffer);

        // Extract product IDs and count
        const productIds = Object.keys(productPrices);
        const totalProducts = productIds.length;
        const NUM_RECORDS_PER_MONTH = totalProducts;

        logger.info(`Total number of products: ${totalProducts}`);
        logger.info(`Number of records per month set to: ${NUM_RECORDS_PER_MONTH}`);

        // Generate randomized units_per_month
        const unitsPerMonth = generateRandomUnitsPerMonth();

        logger.info('Randomized units_per_month values:', unitsPerMonth);

        // List to collect all data for consolidation
        const consolidatedData = [];

        // Generate a unique identifier for this generation
        const generationId = Date.now();

        // Loop through all months
        for (let month = 1; month <= 12; month++) {
            const monthNameAbbr = getMonthAbbreviation(month);
            const unitsMax = Math.floor(unitsPerMonth[monthNameAbbr] || 6); // Ensure integer

            // Generate sample data for the current month
            const sampleData = generateData(
                NUM_RECORDS_PER_MONTH,
                parseInt(specifiedYear),
                month,
                unitsMax,
                productIds,
                totalProducts,
                productPrices,
                supplierId
            );

            // Append to consolidated data
            consolidatedData.push(...sampleData);
        }

        // Convert consolidated data to CSV string
        const consolidatedCsvString = convertDataToCSV(consolidatedData);

        // Define the consolidated CSV filename
        const consolidatedCsvFilename = `consolidated_${supplierId}_${specifiedYear}_generated_transactions_with_prices_${generationId}.csv`;

        // Create a Readable stream from the CSV string
        const bufferStream = new stream.PassThrough();
        bufferStream.end(Buffer.from(consolidatedCsvString));

        // Set headers to prompt file download
        res.setHeader('Content-Disposition', `attachment; filename=${consolidatedCsvFilename}`);
        res.setHeader('Content-Type', 'text/csv');

        // Pipe the CSV data to the response
        bufferStream.pipe(res);

        logger.info(`Consolidated data has been generated and sent for download as ${consolidatedCsvFilename}`);

    } catch (error) {
        logger.error(`Error during generation: ${error.message}`);
        res.render('index', { error: `Error during generation: ${error.message}`, message: null });
    }
});

/**
 * Load product prices from a CSV buffer.
 * @param {Buffer} buffer - CSV file buffer.
 * @returns {Promise<Object>} - Mapping of ProductID to Price.
 */
async function loadProductPricesFromBuffer(buffer) {
    return new Promise((resolve, reject) => {
        const productPrices = {};
        const readable = new stream.Readable();
        readable._read = () => { };
        readable.push(buffer);
        readable.push(null);

        readable
            .pipe(csv())
            .on('headers', (headers) => {
                const requiredHeaders = ['ProductID', 'Price'];
                const missingHeaders = requiredHeaders.filter(header => !headers.includes(header));
                if (missingHeaders.length > 0) {
                    reject(new Error(`CSV is missing required columns: ${missingHeaders.join(', ')}`));
                }
            })
            .on('data', (row) => {
                if (!row.ProductID || !row.Price) {
                    // Skip rows that don't have the required columns
                    return;
                }
                productPrices[row.ProductID] = parseFloat(row.Price);
            })
            .on('end', () => {
                if (Object.keys(productPrices).length === 0) {
                    reject(new Error("CSV must contain 'ProductID' and 'Price' columns with valid data."));
                } else {
                    resolve(productPrices);
                }
            })
            .on('error', (err) => {
                reject(err);
            });
    });
}

/**
 * Generates randomized average units per month.
 * @param {number} minUnits - Minimum average units.
 * @param {number} maxUnits - Maximum average units.
 * @param {number} precision - Number of decimal places.
 * @returns {Object} - Mapping of month abbreviations to units.
 */
function generateRandomUnitsPerMonth(minUnits = 1.0, maxUnits = 15.0, precision = 1) {
    const unitsPerMonth = {};
    for (let month = 1; month <= 12; month++) {
        const monthAbbr = getMonthAbbreviation(month);
        const units = parseFloat((Math.random() * (maxUnits - minUnits) + minUnits).toFixed(precision));
        unitsPerMonth[monthAbbr] = units;
    }
    return unitsPerMonth;
}

/**
 * Generates transaction data for a given month.
 * @param {number} numRecords - Number of records to generate.
 * @param {number} year - The specified year.
 * @param {number} month - The month number (1-12).
 * @param {number} unitsMax - Maximum units per transaction.
 * @param {Array} productIds - Array of product IDs.
 * @param {number} totalProducts - Total number of products.
 * @param {Object} productPrices - Object mapping ProductID to Price.
 * @param {string} supplierId - Supplier ID.
 * @returns {Array} - Array of transaction objects.
 */
function generateData(numRecords, year, month, unitsMax, productIds, totalProducts, productPrices, supplierId) {
    const data = [];
    const branches = [
        'ABG', 'ALB', 'AUK', 'BAL', 'BLM', 'BAY', 'BRN', 'BRI',
        'BUN', 'CAM', 'CBR', 'CAN', 'CHT', 'CHR', 'COB', 'COF',
        'DAR', 'DUB', 'ESS', 'FRK', 'GEE', 'GLF', 'GLC', 'HAM',
        'HOB', 'HOR', 'INV', 'JOO', 'KEW', 'LAU', 'LOG', 'MAN',
        'MAI', 'MRO', 'MEL', 'NPL', 'NCL', 'NOR', 'NSH', 'ORA',
        'PER', 'PAK', 'PAD', 'QUE', 'ROC', 'SRH', 'SUN', 'TAM',
        'TOW', 'WAG', 'WAR', 'WEL', 'WER', 'WOL', 'YAR', 'YEO'
    ];

    const numDaysInMonth = new Date(year, month, 0).getDate();
    const startDate = new Date(year, month - 1, 1);

    for (let i = 0; i < numRecords; i++) {
        const dayOffset = i % numDaysInMonth;
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + dayOffset);

        const supplier = supplierId;
        const branch = branches[Math.floor(Math.random() * branches.length)];
        const invoiceStatus = 'Paid';

        const productId = productIds[i % totalProducts];
        const transactionType = 'Purchase';
        const units = Math.floor(Math.random() * unitsMax) + 1;
        const pricePerUnit = productPrices[productId];
        const value = parseFloat((units * pricePerUnit).toFixed(3));
        const currency = 'AUD';
        const externalRef = '';
        const interfaceDate = '';

        const monthStr = month.toString().padStart(2, '0');
        const primaryKey = `${supplierId}-PRI-${monthStr}-${year}-${i + 1}`;
        const agreementId = '';
        const advisedEarnings = '';
        const orderReference = '';
        const deliveryReference = '';
        const invoiceReference = `${supplierId}-INV-${monthStr}-${year}-${i + 1}`;

        data.push({
            Date: date.toLocaleDateString('en-GB'), // 'dd/mm/yyyy'
            Supplier: supplier,
            Branch: branch,
            'Invoice status': invoiceStatus,
            Product: productId,
            'Transaction Type': transactionType,
            Units: units,
            Value: value,
            Currency: currency,
            'External Reference': externalRef,
            'Interface Date': interfaceDate,
            'Primary Key': primaryKey,
            'Agreement ID': agreementId,
            'Advised Earnings': advisedEarnings,
            'Order Reference': orderReference,
            'Delivery Reference': deliveryReference,
            'Invoice Reference': invoiceReference
        });
    }

    return data;
}

/**
 * Converts an array of transaction objects to a CSV string.
 * @param {Array} data - Array of transaction objects.
 * @returns {string} - CSV formatted string.
 */
function convertDataToCSV(data) {
    const headers = [
        'Date', 'Supplier', 'Branch', 'Invoice status', 'Product',
        'Transaction Type', 'Units', 'Value', 'Currency',
        'External Reference', 'Interface Date', 'Primary Key',
        'Agreement ID', 'Advised Earnings', 'Order Reference',
        'Delivery Reference', 'Invoice Reference',
    ];

    const csvRows = [
        headers.join(','), // header row
        ...data.map(row => headers.map(field => `"${row[field] || ''}"`).join(','))
    ];

    return csvRows.join('\n');
}

/**
 * Returns the abbreviated month name given a month number.
 * @param {number} monthNumber - Month number (1-12).
 * @returns {string} - Abbreviated month name in lowercase.
 */
function getMonthAbbreviation(monthNumber) {
    return new Date(0, monthNumber - 1).toLocaleString('en', { month: 'short' }).toLowerCase();
}

/**
 * Capitalizes the first letter of a string.
 * @param {string} str - Input string.
 * @returns {string} - Capitalized string.
 */
function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// Start the server
const port = process.env.PORT || 8080;
app.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
});
