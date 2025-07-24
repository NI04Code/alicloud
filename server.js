// server.js

const express = require('express');
const path = require('path');
const dotenv = require('dotenv'); // For local development .env file ONLY
const { PrismaClient } = require('@prisma/client');
const OSS = require('ali-oss');
const multer = require('multer');
const KMSClient = require('@alicloud/kms20160120');
const { Config } = require('@alicloud/openapi-client');
const { default: Credential } = require('@alicloud/credentials');

// --- Load Environment Variables ---
// In production, these variables will be set directly in the ECS environment.
// For local development, they will be loaded from the .env file.
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// --- Configuration Variables (will be populated based on environment) ---
// These will be directly populated from process.env in development,
// or from Secrets Manager in production.
let DATABASE_URL;
let OSS_REGION;
let OSS_BUCKET;
let CDN_DOMAIN;

// Explicit OSS Access Keys for local development only
let LOCAL_DEV_OSS_ACCESS_KEY_ID;
let LOCAL_DEV_OSS_ACCESS_KEY_SECRET;


// --- Initialize Alibaba Cloud Clients (Prisma, OSS) ---
let prisma;
let ossClient;

async function initializeServices() {
    try {
        if (isProduction) {
            // --- PRODUCTION ENVIRONMENT (ECS with RAM Role) ---
            console.log('Running in PRODUCTION environment. Fetching config from Secrets Manager.');

            // 1. Initialize Secrets Manager Client (RAM Role handles authentication)
            const cred = new Credential({
                type: 'ecs_ram_role',
                roleName: process.env.RAM_ROLE_NAME, // set this in your ECS env vars
            });

            const config = new Config({
                credential: cred,
            });

            config.endpoint = 'kms.ap-southeast-5.aliyuncs.com'
            const kmsClient = new KMSClient(config);

            // 2. Fetch ALL Application Configuration from Secrets Manager
            if (!process.env.APP_CONFIG_SECRET_NAME) {
                throw new Error("APP_CONFIG_SECRET_NAME environment variable is not set in production.");
            }
            const appConfigSecretResult = await kmsClient.getSecretValue({
                SecretName: process.env.APP_CONFIG_SECRET_NAME,
            });
            const appConfig = JSON.parse(appConfigSecretResult.SecretString);

            DATABASE_URL = appConfig.DATABASE_URL;
            OSS_REGION = appConfig.OSS_REGION;
            OSS_BUCKET = appConfig.OSS_BUCKET;
            CDN_DOMAIN = appConfig.CDN_DOMAIN;

            // 3. Initialize Prisma Client
            prisma = new PrismaClient({
                datasources: {
                    db: { url: DATABASE_URL },
                },
            });
            await prisma.$connect();
            console.log('Prisma connected to RDS via Secrets Manager credentials.');

            // 4. Initialize OSS Client for Production (Internal Endpoint, RAM Role)
            ossClient = new OSS({
                region: OSS_REGION,
                bucket: OSS_BUCKET,
                // IMPORTANT: ECS RAM Role provides credentials, no explicit keys needed.
                endpoint: `${OSS_REGION}-internal.aliyuncs.com`,
            });
            ossClient.useBucket(OSS_BUCKET);
            console.log('OSS client configured for production (internal endpoint, RAM Role).');

        } else {
            // --- LOCAL DEVELOPMENT ENVIRONMENT (using .env file) ---
            console.log('Running in LOCAL DEVELOPMENT environment. Using .env configuration.');

            // 1. Load config directly from process.env (from .env file)
            DATABASE_URL = process.env.DB_URL;
            OSS_REGION = process.env.OSS_REGION;
            OSS_BUCKET = process.env.OSS_BUCKET;
            CDN_DOMAIN = process.env.CDN_DOMAIN;
            LOCAL_DEV_OSS_ACCESS_KEY_ID = process.env.ALI_ACCESS_KEY_ID;
            LOCAL_DEV_OSS_ACCESS_KEY_SECRET = process.env.ALI_ACCESS_KEY_SECRET;

            if (!DATABASE_URL || !OSS_REGION || !OSS_BUCKET || !CDN_DOMAIN) {
                throw new Error("Missing essential environment variables in .env for local development.");
            }

            // 2. Initialize Prisma Client for Local Dev
            prisma = new PrismaClient({
                datasources: {
                    db: { url: DATABASE_URL },
                },
            });
            await prisma.$connect();
            console.log('Prisma connected to local database.');

            // 3. Initialize OSS Client for Local Dev (Public Endpoint, Explicit Keys)
            if (!LOCAL_DEV_OSS_ACCESS_KEY_ID || !LOCAL_DEV_OSS_ACCESS_KEY_SECRET) {
                throw new Error("ALI_CLOUD_ACCESS_KEY_ID/SECRET not found in .env for local OSS access.");
            }
            ossClient = new OSS({
                region: OSS_REGION,
                bucket: OSS_BUCKET,
                accessKeyId: LOCAL_DEV_OSS_ACCESS_KEY_ID,
                accessKeySecret: LOCAL_DEV_OSS_ACCESS_KEY_SECRET,
                endpoint: `https://${OSS_REGION}.aliyuncs.com`, // Public endpoint for local dev
            });
            ossClient.useBucket(OSS_BUCKET);
            console.log('OSS client configured for local development (public endpoint, explicit keys).');
        }

    } catch (error) {
        console.error('Failed to initialize services:', error);
        // Provide more specific hints based on error type if possible
        if (isProduction && error.code === 'SecretNotFound') {
             console.error('Check APP_CONFIG_SECRET_NAME and RAM Role permissions for Secrets Manager.');
        } else if (!isProduction && error.message.includes('ALI_CLOUD_ACCESS_KEY_ID/SECRET')) {
             console.error('Ensure .env has correct Alibaba Cloud Access Keys for local development.');
        }
        process.exit(1); // Exit if critical service initialization fails
    }
}

// Call the async initialization function
initializeServices();

// --- Express App Setup ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const upload = multer({ storage: multer.memoryStorage() });

// --- Routes ---
// Frontend (Handling Pages)
app.get('/', (req, res) => {
    res.render('main');
});

app.get('/images', async (req, res) => {
    res.render('images');
});

app.get('/image/upload', (req, res) => {
    res.render('image-form');
});

app.get('/image/:id', (req, res) => {
    res.render('image-detail');
});

// Backend (Handling Data)
app.get('/api/images', async (req, res) => {
    // Extract pagination parameters from the query string
    const page = parseInt(req.query.page) || 1; // Default to page 1
    const limit = parseInt(req.query.limit) || 10; // Default to 10 items per page
    const skip = (page - 1) * limit; // Calculate how many records to skip

    try {
        if (!prisma) {
            throw new Error("Database not initialized. Please try again later.");
        }

        // Fetch images with pagination
        const images = await prisma.image.findMany({
            skip: skip, // How many records to skip
            take: limit, // How many records to take
            orderBy: { createdAt: 'desc' }, // Order by creation date
        });

        // Get the total count of images for pagination calculations
        const totalImages = await prisma.image.count();
        const totalPages = Math.ceil(totalImages / limit);

        // Add CDN URL to each image object
        const imagesWithCdnUrls = images.map(image => ({
            ...image,
            cdn_url: `https://${CDN_DOMAIN}/${image.imageLink}`
        }));

        // Send a JSON response with images and pagination info
        res.json({
            images: imagesWithCdnUrls,
            currentPage: page,
            totalPages: totalPages,
            hasPreviousPage: page > 1,
            hasNextPage: page < totalPages,
            prevPage: page - 1,
            nextPage: page + 1,
            limit: limit,
            totalItems: totalImages
        });
    } catch (error) {
        console.error('Error fetching images via API (paginated /api/images):', error);
        res.status(500).json({ error: `Error fetching images: ${error.message}` });
    }
});

app.post('/api/image/post', upload.single('imageFile'), async (req, res) => {
    // Check if a file was actually uploaded
    if (!req.file) {
        // Return a 400 Bad Request if no file is present
        return res.status(400).send('No file uploaded. Please select an image to upload.');
    }

    // Get the image title from the form field, or generate a default one
    const title = req.body.title || `Image-${Date.now()}`;
    const fileBuffer = req.file.buffer; // The image data as a Buffer
    const originalname = req.file.originalname; // Original file name
    const mimetype = req.file.mimetype; // File's MIME type

    // Generate a unique key for the object in OSS to avoid conflicts
    const ossObjectKey = `user-upload/${Date.now()}-${Math.random().toString(36).substring(2, 9)}-${originalname}`;

    try {
        // Ensure OSS and Prisma clients are initialized before use
        if (!ossClient || !prisma) {
            throw new Error("Application services (OSS/Database) are not initialized. Please try again later.");
        }

        // Upload the file buffer to Alibaba Cloud OSS
        await ossClient.put(ossObjectKey, fileBuffer, {
            headers: {
                'Content-Type': mimetype // Set the correct Content-Type for the uploaded file
            }
        });
        console.log(`Successfully uploaded ${ossObjectKey} to OSS.`);

        // Save the image metadata (specifically the OSS object key) to the database using Prisma
        await prisma.image.create({
            data: {
                imageLink: ossObjectKey, // Store the OSS key in your database
                title: title,
            },
        });
        console.log(`Saved metadata for ${ossObjectKey} to RDS via Prisma.`);

        // Redirect the user to the image gallery page after successful upload
        // You could also send a JSON success response if this were purely an API.
        res.redirect('/images');
    } catch (err) {
        console.error('Error during image upload or database insert:', err);
        // Send a 500 Internal Server Error response with the error message
        res.status(500).send(`Failed to process image upload: ${err.message}`);
    }
});

app.get('/api/image/:id', async (req, res) => {
    const imageId = parseInt(req.params.id);

    try {
        if (!prisma) { throw new Error("Database not initialized. Please try again later."); }
        const image = await prisma.image.findUnique({
            where: { id: imageId },
            include: {
                comments: {
                    orderBy: { createdAt: 'desc' },
                },
            },
        });

        if (!image) {
            return res.status(404).json({ error: 'Image not found.' });
        }

        // CDN_DOMAIN is globally accessible as per our current server.js structure
        const imageWithCdnUrl = {
            ...image,
            cdn_url: `https://${CDN_DOMAIN}/${image.imageLink}`
        };

        res.json(imageWithCdnUrl);
    } catch (error) {
        console.error('Error fetching image detail via API:', error);
        res.status(500).json({ error: `Error fetching image detail: ${error.message}` });
    }
});

app.post('/api/comment/post', async (req, res) => {
    // Expect imageId and content to be in the request body
    const { imageId, content } = req.body;

    if (!imageId || isNaN(parseInt(imageId))) {
        return res.status(400).json({ error: 'Invalid or missing imageId in request body.' });
    }

    if (!content || content.trim() === '') {
        return res.status(400).json({ error: 'Comment content cannot be empty.' });
    }

    try {
        if (!prisma) {
            throw new Error("Database not initialized. Please try again later.");
        }

        await prisma.comment.create({
            data: {
                content: content,
                imageId: parseInt(imageId), // Ensure imageId is an integer
            },
        });

        // Send a success response. You might return the new comment object,
        // or just a status, depending on what the frontend needs.
        res.status(201).json({ message: 'Comment posted successfully!', comment: { imageId, content } });

    } catch (error) {
        console.error('Error adding comment via /api/comment/post:', error);
        res.status(500).json({ error: `Failed to add comment: ${error.message}` });
    }
});




// --- Start Server ---
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});