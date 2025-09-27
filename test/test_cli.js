#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 Testing Atomic Swap CLI...');
console.log('============================');

// Test commands to run with actual addresses from config
const testCommands = [
    'show-help',
    'show-state',
    'init-swap base ETH USDC 0.00001 0x3644Bd78Cb199f3C0e18bD31dca864D4Af91796E 0x31d63d6d38b8aee284b7d74f9e380a1cfbc48677c1f8f008e0f84db1731ae58b',
    'show-state',
    // Test SUI to Base swap
    'init-swap sui ETH USDC 0.00001 0x31d63d6d38b8aee284b7d74f9e380a1cfbc48677c1f8f008e0f84db1731ae58b 0x3644Bd78Cb199f3C0e18bD31dca864D4Af91796E',
    'show-state',
    'exit'
];

// Start the CLI process
const cliPath = path.join(__dirname, 'atomic_swap_cli.ts');
const child = spawn('npx', ['ts-node', cliPath], {
    stdio: ['pipe', 'pipe', 'pipe']
});

let commandIndex = 0;

// Send commands one by one
const sendNextCommand = () => {
    if (commandIndex < testCommands.length) {
        const command = testCommands[commandIndex];
        console.log(`\n📤 Sending command: ${command}`);
        child.stdin.write(command + '\n');
        commandIndex++;
        
        // Wait a bit before sending next command
        setTimeout(sendNextCommand, 2000);
    }
};

// Handle CLI output
child.stdout.on('data', (data) => {
    console.log('📥 CLI Output:', data.toString());
});

child.stderr.on('data', (data) => {
    console.error('❌ CLI Error:', data.toString());
});

child.on('close', (code) => {
    console.log(`\n✅ CLI process exited with code ${code}`);
    console.log('🧪 Test completed!');
});

// Start sending commands after a short delay
setTimeout(sendNextCommand, 1000);

console.log('⏳ Starting CLI test in 1 second...');
