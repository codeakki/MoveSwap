const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("HTLC", function () {
  // We define a fixture to reuse the same setup in every test.
  async function deployHTLCFixture() {
    const [owner, sender, receiver, otherAccount] = await ethers.getSigners();

    const HTLC = await ethers.getContractFactory("HTLC");
    const htlc = await HTLC.deploy();

    return { htlc, owner, sender, receiver, otherAccount };
  }

  describe("Deployment", function () {
    it("Should deploy successfully", async function () {
      const { htlc } = await loadFixture(deployHTLCFixture);
      expect(htlc.target).to.be.properAddress;
    });
  });

  describe("HTLC Creation", function () {
    it("Should create an HTLC contract", async function () {
      const { htlc, sender, receiver } = await loadFixture(deployHTLCFixture);
      
      const amount = ethers.parseEther("1.0");
      const hashlock = ethers.keccak256(ethers.toUtf8Bytes("secret"));
      const timelock = (await time.latest()) + 3600; // 1 hour from now

      await expect(
        htlc.connect(sender).createHTLC(receiver.address, hashlock, timelock, {
          value: amount,
        })
      ).to.emit(htlc, "HTLCCreated");
    });

    it("Should fail if timelock is in the past", async function () {
      const { htlc, sender, receiver } = await loadFixture(deployHTLCFixture);
      
      const amount = ethers.parseEther("1.0");
      const hashlock = ethers.keccak256(ethers.toUtf8Bytes("secret"));
      const timelock = (await time.latest()) - 1; // 1 second ago

      await expect(
        htlc.connect(sender).createHTLC(receiver.address, hashlock, timelock, {
          value: amount,
        })
      ).to.be.revertedWith("Timelock must be in the future");
    });
  });

  describe("HTLC Withdrawal", function () {
    it("Should allow withdrawal with correct preimage", async function () {
      const { htlc, sender, receiver } = await loadFixture(deployHTLCFixture);
      
      const amount = ethers.parseEther("1.0");
      const secret = "secret";
      const hashlock = ethers.keccak256(ethers.toUtf8Bytes(secret));
      const timelock = (await time.latest()) + 3600;

      // Create HTLC
      const tx = await htlc.connect(sender).createHTLC(
        receiver.address,
        hashlock,
        timelock,
        { value: amount }
      );
      const receipt = await tx.wait();
      const htlcId = receipt.logs[0].args.htlcId;

      // Withdraw with correct preimage
      await expect(
        htlc.connect(receiver).withdraw(htlcId, secret)
      ).to.emit(htlc, "HTLCWithdrawn");
    });
  });

  describe("HTLC Refund", function () {
    it("Should allow refund after timelock expires", async function () {
      const { htlc, sender, receiver } = await loadFixture(deployHTLCFixture);
      
      const amount = ethers.parseEther("1.0");
      const hashlock = ethers.keccak256(ethers.toUtf8Bytes("secret"));
      const timelock = (await time.latest()) + 3600;

      // Create HTLC
      const tx = await htlc.connect(sender).createHTLC(
        receiver.address,
        hashlock,
        timelock,
        { value: amount }
      );
      const receipt = await tx.wait();
      const htlcId = receipt.logs[0].args.htlcId;

      // Fast forward time past timelock
      await time.increaseTo(timelock + 1);

      // Refund
      await expect(
        htlc.connect(sender).refund(htlcId)
      ).to.emit(htlc, "HTLCRefunded");
    });

    it("Should fail refund before timelock expires", async function () {
      const { htlc, sender, receiver } = await loadFixture(deployHTLCFixture);
      
      const amount = ethers.parseEther("1.0");
      const hashlock = ethers.keccak256(ethers.toUtf8Bytes("secret"));
      const timelock = (await time.latest()) + 3600;

      // Create HTLC
      const tx = await htlc.connect(sender).createHTLC(
        receiver.address,
        hashlock,
        timelock,
        { value: amount }
      );
      const receipt = await tx.wait();
      const htlcId = receipt.logs[0].args.htlcId;

      // Try to refund before timelock
      await expect(
        htlc.connect(sender).refund(htlcId)
      ).to.be.revertedWith("Timelock has not expired");
    });
  });
});
