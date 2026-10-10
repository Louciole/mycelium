/**
 * Authentication helpers for E2E tests.
 */

const SERVER_URL = 'http://localhost:808';

/**
 * Creates and logs in a user (follows the real flow: /auth -> /verif -> /channels).
 * @param {Page} page - The Playwright page
 * @param {string} username - Username (used as the email prefix)
 * @returns {Promise<Object>} Logged-in user information
 */
export async function loginUser(page, username) {
    const email = `${username}@test.com`;
    const password = 'Test123!';

    // 1. Go to /auth
    await page.goto(`${SERVER_URL}/auth`);

    // 2. Fill form fields and submit
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);

    // IMPORTANT: Wait for the navigation that happens after submit.
    // The form performs an XHR request then redirects in the callback.
    await Promise.all([
        page.waitForNavigation({ timeout: 10000 }), // Wait for redirect
        page.click('button[type="submit"]')          // Click submit
    ]);

    // 3.1 - If it is a new account, user is redirected to /verif
    const currentUrl = page.url();

    if (currentUrl.includes('/verif')) {
        console.log(`   📧 New account - verification needed for ${email}`);

        // 3.1.1 - Retrieve OTP through the get_debug_otp endpoint
        const otpResponse = await page.request.post(`${SERVER_URL}/get_debug_otp?email=${encodeURIComponent(email)}`);
        if (!otpResponse.ok()) {
            throw new Error(`Failed to get OTP: ${otpResponse.status()}`);
        }
        const { code } = await otpResponse.json();
        console.log(`   🔑 OTP retrieved: ${code}`);

        // 3.1.2 - Fill OTP
        await page.fill('input[name="code"]', code);

        // 3.1.3 - Submit and wait for navigation to /channels
        await Promise.all([
            page.waitForNavigation({ timeout: 10000 }),
            page.click('button[type="submit"]')
        ]);
    }

    // 3.2 - Ensure we are on /channels
    const finalUrl = page.url();
    if (!finalUrl.includes('/channels')) {
        // Capture any displayed error message
        const errorMessage = await page.locator('#messageframe').textContent().catch(() => '');
        throw new Error(`Navigation failed. Current URL: ${finalUrl}. Error: ${errorMessage || 'Unknown'}`);
    }

    console.log(`   ✅ User ${email} logged in and on /channels`);

    return { email, username };
}

/**
 * Logs in multiple users sequentially.
 * @param {Array<{page: Page, username: string}>} users - List of pages and usernames
 * @returns {Promise<Array<Object>>} Logged-in user info list
 */
export async function loginMultipleUsers(users) {
    console.log(`   👥 Logging in ${users.length} users...`);

    const loggedInUsers = [];
    for (const { page, username } of users) {
        const userInfo = await loginUser(page, username);
        loggedInUsers.push(userInfo);
        // Small delay to avoid overloading the server
        if (users.length > 2) {
            await page.waitForTimeout(200);
        }
    }

    console.log(`   ✅ ${users.length} users logged in`);
    return loggedInUsers;
}

/**
 * Waits until the user is fully authenticated and the app is ready.
 * @param {Page} page - The Playwright page
 * @param {number} timeout - Timeout in ms (default: 10000)
 */
export async function waitForAuthComplete(page, timeout = 10000) {
    // Wait for WebSocket connection AND CallManager initialization
    await page.waitForFunction(() => {
        return window.global?.state?.websocket?.readyState === WebSocket.OPEN
            && window.global?.state?.callManager !== undefined
            && window.global?.state?.clientID !== undefined;
    }, undefined, { timeout });

    console.log('   ✅ Auth complete: WebSocket connected and app ready');
}
