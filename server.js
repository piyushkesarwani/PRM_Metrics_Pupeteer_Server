require('dotenv').config();
const express   = require('express');
const puppeteer = require('puppeteer');
const axios     = require('axios');
const jwt       = require('jsonwebtoken');
const fs        = require('fs');
const path      = require('path');

const app = express();
app.use(express.json());

const isWindows = process.platform === 'win32';

const PDFDocument = require('pdfkit');

async function captureDashboard(page) {
    console.log('Locating main dashboard container...');

    const containerSelector = '.oneContent, .slds-template_default';

    await page.waitForSelector(containerSelector, { timeout: 30000 });

    const container = await page.$(containerSelector);

    if (!container) {
        throw new Error('Dashboard container not found');
    }

    console.log('Scrolling inside Lightning container...');

    // Scroll inside Lightning container (NOT window)
    await page.evaluate(async (selector) => {
        const el = document.querySelector(selector);
        if (!el) return;

        await new Promise((resolve) => {
            let total = 0;
            const distance = 500;

            const timer = setInterval(() => {
                el.scrollBy(0, distance);
                total += distance;

                if (total >= el.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 400);
        });
    }, containerSelector);

    console.log('Waiting for charts to fully render...');
    await new Promise(r => setTimeout(r, 8000));

    console.log('Taking FULL PAGE screenshot...');

    const screenshot = await page.screenshot({
        type: 'png',
        fullPage: true
    });

    return screenshot;
}

async function createPdfFromImage(image) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({
            size: 'A4',
            layout: 'landscape',
            margin: 10
        });

        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));

        doc.image(image, {
            fit: [800, 550],
            align: 'center',
            valign: 'center'
        });

        doc.end();
    });
}

// ─── Basic Auth Middleware ────────────────────────────────────────────────────
function basicAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Basic ')) {
        return res.status(401).json({ error: 'Missing auth' });
    }
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [user, pass] = decoded.split(':');
    if (user !== process.env.SERVICE_USERNAME ||
        pass !== process.env.SERVICE_PASSWORD) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    next();
}

// ─── Salesforce JWT OAuth ─────────────────────────────────────────────────────
let sfToken = null;

async function getSfToken() {
    if (sfToken) return sfToken;
    console.log('Fetching SF token via JWT...');

    const privateKey = fs.readFileSync(
        path.join(__dirname, 'server.key'), 'utf8'
    );

    const payload = {
        iss: process.env.SF_CLIENT_ID,
        sub: process.env.SF_USERNAME,
        aud: process.env.SF_LOGIN_URL,
        exp: Math.floor(Date.now() / 1000) + 300
    };

    const assertion = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

    const params = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion:  assertion
    });

    const r = await axios.post(
        `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    sfToken = {
        accessToken: r.data.access_token,
        instanceUrl: r.data.instance_url
    };
    console.log('SF JWT token obtained. instanceUrl:', sfToken.instanceUrl);
    return sfToken;
}

// ─── Launch Browser ───────────────────────────────────────────────────────────
function launchBrowser() {
    // return puppeteer.launch({
    //     headless: 'new',
    //     executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    //     args: [
    //         '--no-sandbox',
    //         '--disable-setuid-sandbox',
    //         '--disable-dev-shm-usage',
    //         '--disable-gpu',
    //         ...(isWindows ? [] : ['--single-process'])
    //     ]
    // });

    return puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });

}

// ─── Safe navigation — swallows frame detach errors from SF redirects ─────────
async function safeGoto(page, url, waitUntil = 'domcontentloaded') {
    try {
        await page.goto(url, { waitUntil, timeout: 60000 });
    } catch (e) {
        if (e.message.includes('detached') || e.message.includes('navigation')) {
            console.log('Redirect swallowed, waiting to settle...');
            await new Promise(r => setTimeout(r, 4000));
        } else {
            throw e;
        }
    }
}

// ─── Wait for URL to stop changing ───────────────────────────────────────────
async function waitForStableUrl(page, maxMs = 20000) {
    const interval = 2000;
    let last = '';
    for (let i = 0; i < maxMs / interval; i++) {
        await new Promise(r => setTimeout(r, interval));
        let cur = '';
        try { cur = page.url(); } catch (e) { continue; }
        if (cur === last && cur !== 'about:blank') {
            console.log('URL stable:', cur);
            return cur;
        }
        console.log('URL changing:', cur);
        last = cur;
    }
    return last;
}

async function loginToSalesforce(page) {
    console.log('Opening Salesforce login page...');

    await page.goto(process.env.SF_LOGIN_URL, {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

    await page.waitForSelector('#username', { timeout: 30000 });

    console.log('Entering credentials...');

    await page.type('#username', process.env.SF_USERNAME, { delay: 50 });
    await page.type('#password', process.env.SF_PASSWORD, { delay: 50 });

    await Promise.all([
        page.click('#Login'),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
    ]);

    const currentUrl = page.url();
    console.log('After login URL:', currentUrl);

    if (currentUrl.includes('login') || currentUrl.includes('error')) {
        throw new Error('Login failed - still on login page');
    }

    console.log('✅ Salesforce UI login successful');

    return currentUrl;
}

// ─── Slack Upload ─────────────────────────────────────────────────────────────
async function postToSlack({ pdfBuffer, filename, channelId, botToken, message }) {
    // Step 1: get upload URL
    const urlResp = await axios.post(
        'https://slack.com/api/files.getUploadURLExternal',
        new URLSearchParams({
            filename, length: pdfBuffer.length
        }).toString(),
        { headers: {
            'Authorization': `Bearer ${botToken}`,
            'Content-Type':  'application/x-www-form-urlencoded'
        }}
    );
    if (!urlResp.data.ok) throw new Error('Slack getUploadURL: ' + urlResp.data.error);

    const { upload_url, file_id } = urlResp.data;

    // Step 2: upload bytes
    await axios.post(upload_url, pdfBuffer, {
        headers: { 'Content-Type': 'application/octet-stream' }
    });
    const dashboardLink = process.env.SF_BASE_URL + (process.env.DEBUG_DASHBOARD_PATH || '');

    // Step 3: finalize
    const finalResp = await axios.post(
        'https://slack.com/api/files.completeUploadExternal',
        {
            files:           [{ id: file_id, title: filename }],
            channel_id:      channelId,
            // initial_comment: message
            initial_comment: ""
        },
        { headers: {
            'Authorization': `Bearer ${botToken}`,
            'Content-Type':  'application/json'
        }}
    );
    const today = new Date().toLocaleDateString();
    // 🔥 Send a rich message separately
    await axios.post(
        'https://slack.com/api/chat.postMessage',
        {
            channel: channelId,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*📊 Weekly Salesforce Dashboard Snapshot  (${today}) *\n\nThe latest dashboard snapshot has been successfully generated and shared.\n\nThis report is automatically scheduled and delivered on a weekly basis to keep you informed of key metrics and performance trends.`
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "View Dashboard in Salesforce"
                            },
                            url: dashboardLink,
                            style: "primary"
                        }
                    ]
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `Dashboard: *${filename}*`
                        }
                    ]
                }
            ]
        },
        {
            headers: {
                'Authorization': `Bearer ${botToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    if (!finalResp.data.ok) throw new Error('Slack completeUpload: ' + finalResp.data.error);
    console.log('Slack upload complete.');
}

// ─── Health / Ping ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/ping', (req, res) => {
    console.log('PING', new Date().toISOString());
    res.json({ pong: true });
});

// ─── Test JWT ─────────────────────────────────────────────────────────────────
app.get('/test-jwt', async (req, res) => {
    try {
        sfToken = null;
        const { accessToken, instanceUrl } = await getSfToken();
        res.json({ success: true, instanceUrl, tokenPreview: accessToken.substring(0, 30) + '...' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});

// ─── Debug Screenshot ─────────────────────────────────────────────────────────
app.get('/debug-screenshot', async (req, res) => {
    let browser;
    try {
        sfToken = null;
        // const { accessToken, instanceUrl } = await getSfToken();

        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Step 1: establish session (front-door + Lightning bridge)
        await loginToSalesforce(page);
        const currentUrl = page.url();
        const urlObj = new URL(currentUrl);
        const lightningBase = `${urlObj.protocol}//${urlObj.hostname}`;
        // Force Lightning to fully initialize (VERY IMPORTANT)
        await page.goto(`${lightningBase}/lightning/page/home`, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        const urlAfterLogin = page.url();

        const shot1 = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('Shot 1 URL:', urlAfterLogin);

        // Step 2: navigate to Lightning home
        await safeGoto(page, lightningBase);
        await new Promise(r => setTimeout(r, 5000));
        const url2 = page.url();
        const shot2 = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('Shot 2 URL:', url2);

        // Step 3: navigate to the actual dashboard
        // Extract just the path from dashboardUrl in case it's a full URL
        const rawDash = process.env.DEBUG_DASHBOARD_PATH ||
                        '/lightning/r/Dashboard/01Zgb0000000NuHEAU/view';
        const dashPath = rawDash.startsWith('http')
            ? new URL(rawDash).pathname
            : rawDash;
        const fullDashUrl = lightningBase + dashPath;

        console.log('Navigating to dashboard:', fullDashUrl);
        await safeGoto(page, fullDashUrl);
        await new Promise(r => setTimeout(r, 8000));
        const url3 = page.url();
        const shot3 = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('Shot 3 URL:', url3);

        res.send(`
            <h2>Step 1 — After Front-Door + Lightning Bridge</h2>
            <p><b>URL:</b> ${urlAfterLogin}</p>
            <img src="data:image/png;base64,${shot1}"
                 style="max-width:100%;border:1px solid #ccc;margin-bottom:30px"/>
            <h2>Step 2 — Lightning Home</h2>
            <p><b>URL:</b> ${url2}</p>
            <img src="data:image/png;base64,${shot2}"
                 style="max-width:100%;border:1px solid #ccc;margin-bottom:30px"/>
            <h2>Step 3 — Dashboard</h2>
            <p><b>URL:</b> ${url3}</p>
            <img src="data:image/png;base64,${shot3}"
                 style="max-width:100%;border:1px solid #ccc"/>
        `);

    } catch (err) {
        console.error('Debug error:', err.message);
        res.send(`<h2>Error</h2><pre>${err.message}\n\n${err.stack}</pre>`);
    } finally {
        if (browser) await browser.close();
    }
});

// ─── Main Capture Endpoint ────────────────────────────────────────────────────
app.post('/capture', basicAuth, async (req, res) => {
    const {
        dashboardUrl,
        dashboardName,
        waitMs = 8000,
        slackChannelId,
        slackBotToken,
        slackMessage
    } = req.body;

    // Respond immediately — Apex 120s timeout won't wait for the full capture
    res.status(202).json({ status: 'queued' });

    (async () => {
        let browser;
        try {
            console.log('--- Starting capture:', dashboardName);

            // Step 1: JWT token
            // const { accessToken, instanceUrl } = await getSfToken();

            // Step 2: Build dashboard path (handle full URL or path-only)
            const dashPath = dashboardUrl.startsWith('http')
                ? new URL(dashboardUrl).pathname
                : dashboardUrl;

            // Step 3: Launch browser
            browser = await launchBrowser();
            const page = await browser.newPage();
            // await page.setViewport({ width: 1920, height: 1080 });
            await page.setViewport({
                width: 1920,
                height: 2000,   // 🔥 important (taller viewport)
                deviceScaleFactor: 1
            });

            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            // Step 4: Establish session via front-door + Lightning bridge
            // const { lightningBase } = await establishSession(
            //     page, accessToken, instanceUrl
            // );

            await loginToSalesforce(page);
            // const lightningBase = page.url().split('/lightning')[0];
            const currentUrl = page.url();
            const urlObj = new URL(currentUrl);
            const lightningBase = `${urlObj.protocol}//${urlObj.hostname}`;
            
            // Force Lightning to fully initialize (VERY IMPORTANT)
            await page.goto(`${lightningBase}/lightning/page/home`, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            // Step 5: Navigate to the dashboard
            const fullDashUrl = lightningBase + dashPath;
            console.log('Navigating to dashboard:', fullDashUrl);
            await safeGoto(page, fullDashUrl);

            // Step 6: Wait for Lightning to boot
            console.log('Waiting for Lightning to boot...');
            await new Promise(r => setTimeout(r, 6000));

            // Step 7: Check URL — should be on dashboard, not login
            // const currentUrl = page.url();
            console.log('URL after dashboard navigation:', currentUrl);

            if (currentUrl.includes('login') || currentUrl.includes('ec=302')) {
                throw new Error(
                    'Still being redirected to login after all attempts. ' +
                    'URL: ' + currentUrl
                );
            }

            // Step 8: Wait for dashboard container selector
            try {
                await page.waitForSelector(
                    '.dashboardGrid, .slds-page-header, lightning-dashboard, .oneContent',
                    { visible: true, timeout: 30000 }
                );
                console.log('Dashboard container found.');
            } catch (e) {
                console.log('Dashboard selector not found — continuing anyway.');
            }

            // Step 9: Wait for charts to render
            console.log(`Waiting ${waitMs}ms for charts to render...`);
            await new Promise(r => setTimeout(r, waitMs));

            // Step 10: Capture dashboard properly
            console.log('Capturing dashboard...');
            const image = await captureDashboard(page);

            // Step 11: Convert to PDF
            console.log('Creating PDF...');
            const pdfBuffer = await createPdfFromImage(image);

            console.log('PDF created. Size:', pdfBuffer.length);

            // Step 12: Upload to Slack
            console.log('Uploading to Slack...');
            await postToSlack({
                pdfBuffer,
                filename:  `${dashboardName}_${Date.now()}.pdf`,
                channelId: slackChannelId,
                botToken:  slackBotToken,
                message:   slackMessage
            });

            console.log('✅  Posted', dashboardName, 'to Slack');

        } catch (err) {
            sfToken = null;
            console.error('❌  Failed:', err.message);
            console.error(err.stack);
        } finally {
            if (browser) await browser.close();
        }
    })();
});

app.get('/my-ip', async (req, res) => {
    try {
        const r = await axios.get('https://api.ipify.org?format=json');
        res.json({ 
            serverIp: r.data.ip,
            clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress 
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/test-api', async (req, res) => {
    try {
        sfToken = null;
        const { accessToken, instanceUrl } = await getSfToken();

        // Test if the token works for API calls (this bypasses browser session)
        const userInfo = await axios.get(
            `${instanceUrl}/services/oauth2/userinfo`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        // Also test a simple REST API call
        const orgInfo = await axios.get(
            `${instanceUrl}/services/data/v59.0/`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        res.json({
            success: true,
            userInfo: {
                username:    userInfo.data.preferred_username,
                userId:      userInfo.data.user_id,
                orgId:       userInfo.data.organization_id,
                profileId:   userInfo.data.profile,
                email:       userInfo.data.email,
            },
            apiWorks: true,
            apiVersions: orgInfo.data.length + ' API versions available'
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.response?.data || err.message
        });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
});
