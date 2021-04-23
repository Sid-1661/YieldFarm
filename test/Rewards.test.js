const { expect } = require('chai')
//const { ethers } = require('@nomiclabs/buidler')
const { ethers } = require("ethers");

describe('Rewards', function () {
    let Rewards
    let staking
    let owner, user, communityVault, userAddr, communityVaultAddr
    let bondToken, usdc, susd, dai
    const distributedAmount = ethers.BigNumber.from(800000).mul(ethers.BigNumber.from(10).pow(18))
    let snapshotId
    const epochDuration = 1000

    const amount = ethers.BigNumber.from(100).mul(ethers.BigNumber.from(10).pow(18))
    const amountUSDC = amount.div(ethers.BigNumber.from(10).pow(12))
    beforeEach(async function () {
        snapshotId = await ethers.provider.send('evm_snapshot')
        const [creator, ownerSigner, userSigner] = await ethers.getSigners()
        owner = ownerSigner
        user = userSigner
        userAddr = await user.getAddress()

        const Staking = await ethers.getContractFactory('Staking', creator)

        staking = await Staking.deploy(Math.floor(Date.now() / 1000) + 1000, epochDuration)
        await staking.deployed()

        const ERC20Mock6Decimals = await ethers.getContractFactory('ERC20Mock6Decimals')
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock')
        const CommunityVault = await ethers.getContractFactory('CommunityVault')

        bondToken = await ERC20Mock.deploy()
        usdc = await ERC20Mock6Decimals.deploy()
        susd = await ERC20Mock.deploy()
        dai = await ERC20Mock.deploy()
        communityVault = await CommunityVault.deploy(bondToken.address)
        communityVaultAddr = communityVault.address
        const Rewards = await ethers.getContractFactory('Rewards')
        Rewards = await Rewards.deploy(
            bondToken.address,
            usdc.address,
            susd.address,
            dai.address,
            staking.address,
            communityVaultAddr,
        )
        await bondToken.mint(communityVaultAddr, distributedAmount)
        await communityVault.connect(creator).setAllowance(Rewards.address, distributedAmount)
    })

    afterEach(async function () {
        await ethers.provider.send('evm_revert', [snapshotId])
    })

    describe('General Contract checks', function () {
        it('should be deployed', async function () {
            expect(staking.address).to.not.equal(0)
            expect(Rewards.address).to.not.equal(0)
            expect(bondToken.address).to.not.equal(0)
        })
        it('Get epoch PoolSize and distribute tokens', async function () {
            await depositUsdc(amountUSDC)
            await depositSUsd(amount)
            await depositDai(amount)
            await moveAtEpoch(3)

            const totalAmount = amount.mul(3)
            expect(await Rewards.getPoolSize(1)).to.equal(totalAmount)
            expect(await Rewards.getEpochStake(userAddr, 1)).to.equal(totalAmount)
            expect(await bondToken.allowance(communityVaultAddr, Rewards.address)).to.equal(distributedAmount)
            expect(await Rewards.getCurrentEpoch()).to.equal(3)

            await Rewards.connect(user).harvest(1)
            expect(await bondToken.balanceOf(userAddr)).to.equal(distributedAmount.div(25))
        })
    })

    describe('Contract Tests', function () {
        it('User harvest and mass Harvest', async function () {
            await depositUsdc(amountUSDC)
            await depositSUsd(amount, owner)
            const totalAmount = amount.mul(2)
            await moveAtEpoch(8)

            expect(await Rewards.getPoolSize(1)).to.equal(totalAmount)
            expect(await Rewards.lastInitializedEpoch()).to.equal(0) // no epoch initialized
            await expect(Rewards.harvest(10)).to.be.revertedWith('This epoch is in the future')
            await expect(Rewards.harvest(3)).to.be.revertedWith('Harvest in order')

            await (await Rewards.connect(user).harvest(1)).wait()
            expect(await bondToken.balanceOf(userAddr)).to.equal(
                amount.mul(distributedAmount.div(25)).div(totalAmount),
            )
            expect(await Rewards.connect(user).userLastEpochIdHarvested()).to.equal(1)
            expect(await Rewards.lastInitializedEpoch()).to.equal(1) // epoch 1 have been initialized

            await (await Rewards.connect(user).massHarvest()).wait()
            const totalDistributedAmount = amount.mul(distributedAmount.div(25)).div(totalAmount).mul(7)
            expect(await bondToken.balanceOf(userAddr)).to.equal(totalDistributedAmount)
            expect(await Rewards.connect(user).userLastEpochIdHarvested()).to.equal(7)
            expect(await Rewards.lastInitializedEpoch()).to.equal(7) // epoch 7 have been initialized
        })

        it('Have nothing to harvest', async function () {
            await depositSUsd(amount)
            await moveAtEpoch(9)
            expect(await Rewards.getPoolSize(1)).to.equal(amount)
            await Rewards.connect(owner).harvest(1)
            expect(await bondToken.balanceOf(await owner.getAddress())).to.equal(0)
            await Rewards.connect(owner).massHarvest()
            expect(await bondToken.balanceOf(await owner.getAddress())).to.equal(0)
        })

        it('harvest maximum 25 epochs', async function () {
            await depositUsdc(amountUSDC)
            const totalAmount = amount
            await moveAtEpoch(30)

            expect(await Rewards.getPoolSize(1)).to.equal(totalAmount)
            await (await Rewards.connect(user).massHarvest()).wait()
            expect(await Rewards.lastInitializedEpoch()).to.equal(25) // epoch 7 have been initialized
        })

        it('gives epochid = 0 for previous epochs', async function () {
            await moveAtEpoch(-2)
            expect(await Rewards.getCurrentEpoch()).to.equal(0) // epoch 7 have been initialized
        })

        it('it should return 0 if no deposit in an epoch', async function () {
            await moveAtEpoch(3)
            await Rewards.connect(owner).harvest(1)
            expect(await bondToken.balanceOf(await owner.getAddress())).to.equal(0)
        })
    })

    describe('Events', function () {
        it('Harvest emits Harvest', async function () {
            await depositUsdc(amountUSDC)
            await depositSUsd(amount, owner)
            await moveAtEpoch(9)

            await expect(Rewards.connect(user).harvest(1))
                .to.emit(Rewards, 'Harvest')
        })

        it('MassHarvest emits MassHarvest', async function () {
            await depositUsdc(amountUSDC)
            await depositSUsd(amount, owner)
            await moveAtEpoch(9)

            await expect(Rewards.connect(user).massHarvest())
                .to.emit(Rewards, 'MassHarvest')
        })
    })

    function getCurrentUnix () {
        return Math.floor(Date.now() / 1000)
    }

    async function setNextBlockTimestamp (timestamp) {
        const block = await ethers.provider.send('eth_getBlockByNumber', ['latest', false])
        const currentTs = block.timestamp
        const diff = timestamp - currentTs
        await ethers.provider.send('evm_increaseTime', [diff])
    }

    async function moveAtEpoch (epoch) {
        await setNextBlockTimestamp(getCurrentUnix() + epochDuration * epoch)
        await ethers.provider.send('evm_mine')
    }

    async function depositUsdc (x, u = user) {
        const ua = await u.getAddress()
        await usdc.mint(ua, x)
        await usdc.connect(u).approve(staking.address, x)
        return await staking.connect(u).deposit(usdc.address, x)
    }

    async function depositSUsd (x, u = user) {
        const ua = await u.getAddress()
        await susd.mint(ua, x)
        await susd.connect(u).approve(staking.address, x)
        return await staking.connect(u).deposit(susd.address, x)
    }

    async function depositDai (x, u = user) {
        const ua = await u.getAddress()
        await dai.mint(ua, x)
        await dai.connect(u).approve(staking.address, x)
        return await staking.connect(u).deposit(dai.address, x)
    }
})
