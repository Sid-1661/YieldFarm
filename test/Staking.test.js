const { expect } = require('chai')
//const { ethers } = require('@nomiclabs/buidler')
//const {ethers} = require('@nomiclabs/hardhat-ethers')

const { ethers } = require("ethers");

//const BN = require('bignumber.js');

const BN = ethers.BigNumber

describe('Staking', function () {
    let staking
    let erc20Mock
    let owner, user
    let ownerAddr, userAddr
    const amount = BN.from(100).mul(BN.from(10).pow(18))
    const MULTIPLIER_DECIMALS = 18
    const BASE_MULTIPLIER = BN.from(10).pow(MULTIPLIER_DECIMALS)
    let snapshotId

    const epochDuration = 604800
    let epoch1Start

    beforeEach(async function () {
        snapshotId = await ethers.provider.send('evm_snapshot')

        const [creator, ownerSigner, userSigner] = await ethers.getSigners()
        owner = ownerSigner
        ownerAddr = await owner.getAddress()

        user = userSigner
        userAddr = await user.getAddress()

        const Staking = await ethers.getContractFactory('Staking', creator)

        epoch1Start = getCurrentUnix() + 1000
        staking = await Staking.deploy(epoch1Start, epochDuration)
        await staking.deployed()

        const ERC20Mock = await ethers.getContractFactory('ERC20Mock')
        erc20Mock = await ERC20Mock.deploy()
        await erc20Mock.deployed()
    })

    afterEach(async function () {
        await ethers.provider.send
            ('evm_revert', [snapshotId])
    })

    it('Can deploy successfully', async function () {
        expect(staking.address).to.not.equal(0)
    })

    describe('Deposit', function () {
        it('Reverts if amount is <= 0', async function () {
            await expect(
                staking.connect(user).deposit(erc20Mock.address, 0),
            ).to.be.revertedWith('Staking: Amount must be > 0')
        })

        it('Reverts if amount > allowance', async function () {
            await erc20Mock.mint(userAddr, amount)
            // no allowance

            await expect(
                staking.connect(user).deposit(erc20Mock.address, amount),
            ).to.be.revertedWith('Staking: Token allowance too small')
        })

        it('Saves users deposit in state', async function () {
            await erc20Mock.mint(userAddr, amount)
            await erc20Mock.connect(user).approve(staking.address, amount)

            await staking.connect(user).deposit(erc20Mock.address, amount)

            const balance = await staking.balanceOf(userAddr, erc20Mock.address)

            expect(balance.toString()).to.be.equal(amount.toString())
        })

        it('Calls transferFrom when conditions are met', async function () {
            await erc20Mock.mint(userAddr, amount)
            await erc20Mock.connect(user).approve(staking.address, amount)

            await staking.connect(user).deposit(erc20Mock.address, amount)

            expect(await erc20Mock.transferFromCalled()).to.be.true
        })

        it('Updates the pool size of the next epoch', async function () {
            await erc20Mock.mint(userAddr, amount)
            await erc20Mock.connect(user).approve(staking.address, amount)

            await staking.connect(user).deposit(erc20Mock.address, amount)

            expect((await staking.getEpochPoolSize(erc20Mock.address, 1)).toString()).to.be.equal(amount.toString())
        })

        it('Updates the user balance of the next epoch', async function () {
            await erc20Mock.mint(userAddr, amount.mul(10))
            await erc20Mock.connect(user).approve(staking.address, amount.mul(10))

            await staking.connect(user).deposit(erc20Mock.address, amount)

            expect(
                (await staking.getEpochUserBalance(userAddr, erc20Mock.address, 1)).toString(),
            ).to.be.equal(amount.toString())

            // move forward to epoch 1
            // do one more deposit then check that the user balance is still correct
            await moveAtEpoch(1)

            await staking.connect(user).deposit(erc20Mock.address, amount)

            expect(
                (await staking.getEpochUserBalance(userAddr, erc20Mock.address, 2)).toString(),
            ).to.be.equal(amount.mul(2).toString())
        })

        describe('Continuous deposits', function () {
            beforeEach(async function () {
                await erc20Mock.mint(userAddr, amount.mul(10))
                await erc20Mock.mint(ownerAddr, amount.mul(10))
                await erc20Mock.connect(user).approve(staking.address, amount.mul(10))
                await erc20Mock.connect(owner).approve(staking.address, amount.mul(10))
            })

            it('Deposit at random points inside an epoch sets the correct effective balance', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)

                const NUM_CHECKS = 5
                for (let i = 0; i < NUM_CHECKS; i++) {
                    const snapshotId = await ethers.provider.send('evm_snapshot')

                    const ts = Math.floor(Math.random() * epochDuration)

                    await setNextBlockTimestamp(epoch1Start + ts)
                    await deposit(user, amount)

                    const multiplier = multiplierAtTs(1, await getBlockTimestamp())
                    const expectedBalance = computeEffectiveBalance(amount, multiplier)

                    expect(await getEpochUserBalance(userAddr, 1)).to.equal(expectedBalance)
                    expect(await getEpochUserBalance(userAddr, 2)).to.equal(amount)
                    expect(await getEpochPoolSize(1)).to.equal(expectedBalance)
                    expect(await getEpochPoolSize(2)).to.equal(amount)

                    await ethers.provider.send('evm_revert', [snapshotId])
                }
            })

            it('deposit in middle of epoch 1', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)

                await setNextBlockTimestamp(getEpochStart(1) + Math.floor(epochDuration / 2))

                await deposit(user, amount)

                const expectedMultiplier = multiplierAtTs(1, await getBlockTimestamp())
                const expectedBalance = computeEffectiveBalance(amount, expectedMultiplier)

                expect(await getEpochUserBalance(userAddr, 1)).to.equal(expectedBalance)
                expect(await getEpochUserBalance(userAddr, 2)).to.equal(amount)

                expect(await getEpochPoolSize(1)).to.equal(expectedBalance)
                expect(await getEpochPoolSize(2)).to.equal(amount)
            })

            it('deposit epoch 1, deposit epoch 4', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)

                await setNextBlockTimestamp(getEpochStart(1) + Math.floor(epochDuration / 2))
                await deposit(user, amount)

                await moveAtEpoch(4)
                await staking.manualEpochInit([erc20Mock.address], 3)

                await setNextBlockTimestamp(getEpochStart(4) + Math.floor(epochDuration / 2))

                expect(await getEpochUserBalance(userAddr, 4)).to.equal(amount)

                await deposit(user, amount)

                const expectedMultiplier = multiplierAtTs(4, await getBlockTimestamp())
                const totalMultiplier = calculateMultiplier(amount, BASE_MULTIPLIER, amount, expectedMultiplier)
                const expectedBalance = computeEffectiveBalance(amount.mul(2), totalMultiplier)

                expect(await getEpochUserBalance(userAddr, 4)).to.equal(expectedBalance)
                expect(await getEpochUserBalance(userAddr, 5)).to.equal(amount.mul(2))

                expect(await getEpochPoolSize(4)).to.equal(expectedBalance)
                expect(await getEpochPoolSize(5)).to.equal(amount.mul(2))
            })

            it('deposit epoch 1, deposit epoch 2', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)
                await setNextBlockTimestamp(getEpochStart(1) + Math.floor(epochDuration / 2))
                await deposit(user, amount)

                await moveAtEpoch(2)
                await setNextBlockTimestamp(getEpochStart(2) + Math.floor(epochDuration / 2))

                expect(await getEpochUserBalance(userAddr, 2)).to.equal(amount)

                await deposit(user, amount)

                const expectedMultiplier = multiplierAtTs(2, await getBlockTimestamp())
                const totalMultiplier = calculateMultiplier(amount, BASE_MULTIPLIER, amount, expectedMultiplier)
                const expectedBalance = computeEffectiveBalance(amount.mul(2), totalMultiplier)

                expect(await getEpochUserBalance(userAddr, 2)).to.equal(expectedBalance)
                expect(await getEpochUserBalance(userAddr, 3)).to.equal(amount.mul(2))

                expect(await getEpochPoolSize(2)).to.equal(expectedBalance)
                expect(await getEpochPoolSize(3)).to.equal(amount.mul(2))
            })

            it('deposit epoch 1, deposit epoch 5, deposit epoch 5', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)
                await setNextBlockTimestamp(getEpochStart(1) + Math.floor(epochDuration / 2))
                await deposit(user, amount)

                await moveAtEpoch(5)
                await staking.manualEpochInit([erc20Mock.address], 3)
                await staking.manualEpochInit([erc20Mock.address], 4)

                await setNextBlockTimestamp(getEpochStart(5) + Math.floor(epochDuration / 2))
                await deposit(user, amount)

                const expectedMultiplier = multiplierAtTs(5, await getBlockTimestamp())
                const totalMultiplier = calculateMultiplier(amount, BASE_MULTIPLIER, amount, expectedMultiplier)

                await setNextBlockTimestamp(getEpochStart(5) + Math.floor(epochDuration * 3 / 4))
                await deposit(user, amount)

                const expectedMultiplier2 = multiplierAtTs(5, await getBlockTimestamp())
                const totalMultiplier2 = calculateMultiplier(
                    amount.mul(2),
                    totalMultiplier,
                    amount,
                    expectedMultiplier2,
                )
                const expectedBalance = computeEffectiveBalance(amount.mul(3), totalMultiplier2)

                expect(await getEpochUserBalance(userAddr, 5)).to.equal(expectedBalance)
                expect(await getEpochUserBalance(userAddr, 6)).to.equal(amount.mul(3))

                expect(await getEpochPoolSize(5)).to.equal(expectedBalance)
                expect(await getEpochPoolSize(6)).to.equal(amount.mul(3))
            })
        })
    })

    describe('Withdraw', function () {
        it('Reverts if user has no balance', async function () {
            await expect(
                staking.connect(user).withdraw(erc20Mock.address, amount),
            ).to.be.revertedWith('Staking: balance too small')
        })

        it('Sets the balance of the user to 0', async function () {
            // set-up the balance sheet
            await erc20Mock.mint(userAddr, amount)
            await erc20Mock.connect(user).approve(staking.address, amount)

            await deposit(user, amount)
            await withdraw(user, amount)

            const balance = await staking.balanceOf(userAddr, erc20Mock.address)

            expect(balance.toString()).to.be.equal('0')
        })

        it('Calls the `transfer` function on token when all conditions are met', async function () {
            // set-up the balance sheet
            await erc20Mock.mint(userAddr, amount)
            await erc20Mock.connect(user).approve(staking.address, amount)
            await staking.connect(user).deposit(erc20Mock.address, amount)

            await withdraw(user, amount)

            expect(await erc20Mock.transferCalled()).to.be.true
            expect(await erc20Mock.transferRecipient()).to.be.equal(userAddr)
            expect((await erc20Mock.transferAmount()).toString()).to.be.equal(amount.toString())
        })

        describe('Partial withdraw', function () {
            beforeEach(async function () {
                await erc20Mock.mint(userAddr, amount.mul(10))
                await erc20Mock.mint(ownerAddr, amount.mul(10))
                await erc20Mock.connect(user).approve(staking.address, amount.mul(10))
                await erc20Mock.connect(owner).approve(staking.address, amount.mul(10))
            })

            it('deposit epoch 1, withdraw epoch 5', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)

                await deposit(user, amount)

                await moveAtEpoch(5)
                await staking.manualEpochInit([erc20Mock.address], 3)
                await staking.manualEpochInit([erc20Mock.address], 4)

                const ts = getEpochStart(1) + 24 * 60 * 60
                await setNextBlockTimestamp(ts)

                await withdraw(user, amount.div(2))

                expect(await getEpochUserBalance(userAddr, 5)).to.equal(amount.div(2))
                expect(await getEpochPoolSize(5)).to.equal(amount.div(2))
            })

            it('deposit epoch 1, withdraw epoch 2', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)

                await deposit(user, amount)

                await moveAtEpoch(2)

                const ts = getEpochStart(1) + 24 * 60 * 60
                await setNextBlockTimestamp(ts)

                await withdraw(user, amount.div(2))

                expect(await getEpochUserBalance(userAddr, 2)).to.equal(amount.div(2))
                expect(await getEpochPoolSize(2)).to.equal(amount.div(2))
            })

            it('deposit epoch 1, deposit epoch 5, withdraw epoch 5 half amount', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)

                await deposit(user, amount)

                await moveAtEpoch(5)
                await staking.manualEpochInit([erc20Mock.address], 3)
                await staking.manualEpochInit([erc20Mock.address], 4)

                const ts = getEpochStart(1) + 24 * 60 * 60
                await setNextBlockTimestamp(ts)

                await deposit(user, amount)

                const ts1 = getEpochStart(1) + Math.floor(epochDuration / 2)
                await setNextBlockTimestamp(ts1)

                const balance = await getEpochUserBalance(userAddr, 5)

                await withdraw(user, amount.div(2))

                const avgDepositMultiplier = BN.from(balance).sub(amount)
                    .mul(BASE_MULTIPLIER)
                    .div(amount)

                const postWithdrawMultiplier = calculateMultiplier(
                    amount,
                    BASE_MULTIPLIER,
                    amount.div(2),
                    avgDepositMultiplier,
                )

                const expectedBalance = computeEffectiveBalance(amount.add(amount.div(2)), postWithdrawMultiplier)

                expect(await getEpochUserBalance(userAddr, 5)).to.equal(expectedBalance)
                expect(await getEpochUserBalance(userAddr, 6)).to.equal(amount.add(amount.div(2)))
                expect(await getEpochPoolSize(5)).to.equal(expectedBalance)
                expect(await getEpochPoolSize(6)).to.equal(amount.add(amount.div(2)))
            })

            it('deposit epoch 1, deposit epoch 5, withdraw epoch 5 more than deposited', async function () {
                await moveAtEpoch(1)
                await staking.manualEpochInit([erc20Mock.address], 0)

                await deposit(user, amount)

                await moveAtEpoch(5)
                await staking.manualEpochInit([erc20Mock.address], 3)
                await staking.manualEpochInit([erc20Mock.address], 4)

                const ts = getEpochStart(1) + 24 * 60 * 60
                await setNextBlockTimestamp(ts)

                await deposit(user, amount)

                const ts1 = getEpochStart(1) + Math.floor(epochDuration / 2)
                await setNextBlockTimestamp(ts1)

                await withdraw(user, amount.add(amount.div(2)))

                expect(await getEpochUserBalance(userAddr, 5)).to.equal(amount.div(2))
                expect(await getEpochUserBalance(userAddr, 6)).to.equal(amount.div(2))
                expect(await getEpochPoolSize(5)).to.equal(amount.div(2))
                expect(await getEpochPoolSize(6)).to.equal(amount.div(2))
            })
        })
    })

    describe('Epoch logic', function () {
        beforeEach(async function () {
            await erc20Mock.mint(userAddr, amount.mul(10))
            await erc20Mock.mint(ownerAddr, amount.mul(10))
            await erc20Mock.connect(user).approve(staking.address, amount.mul(10))
            await erc20Mock.connect(owner).approve(staking.address, amount.mul(10))
        })

        it('deposit in epoch 0, deposit in epoch 1, deposit in epoch 2, withdraw in epoch 3', async function () {
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal('0')

            // epoch 0
            await setNextBlockTimestamp(getCurrentUnix() + 15)
            await deposit(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal(amount.toString())

            await moveAtEpoch(1)
            await deposit(user, amount)

            expect(await getEpochPoolSize(2)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochUserBalance(userAddr, 2)).to.be.equal(amount.mul(2).toString())

            await moveAtEpoch(2)
            await deposit(user, amount)

            expect(await getEpochPoolSize(3)).to.be.equal(amount.mul(3).toString())
            expect(await getEpochUserBalance(userAddr, 3)).to.be.equal(amount.mul(3).toString())

            await moveAtEpoch(3)
            await withdraw(user, amount.mul(3))

            expect(await getEpochPoolSize(4)).to.be.equal('0')
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal('0')
        })

        it('deposit in epoch 0, withdraw in epoch 3', async function () {
            // epoch 0
            await setNextBlockTimestamp(getCurrentUnix() + 15)
            await deposit(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal(amount.toString())

            await moveAtEpoch(3)
            await staking.manualEpochInit([erc20Mock.address], 2)

            await withdraw(user, amount)

            expect(await getEpochPoolSize(4)).to.be.equal('0')
        })

        it('deposit in epoch 0, withdraw in epoch 0', async function () {
            // epoch 0
            await setNextBlockTimestamp(getCurrentUnix() + 15)
            await deposit(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal(amount.toString())

            await withdraw(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal('0')
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal('0')
        })

        it('deposit in epoch 3, withdraw in epoch 3', async function () {
            await moveAtEpoch(3)
            await staking.manualEpochInit([erc20Mock.address], 0)
            await staking.manualEpochInit([erc20Mock.address], 1)
            await staking.manualEpochInit([erc20Mock.address], 2)

            await deposit(user, amount)

            expect(await getEpochPoolSize(4)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal(amount.toString())

            await withdraw(user, amount)

            expect(await getEpochPoolSize(4)).to.be.equal('0')
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal('0')
        })

        it('deposit in epoch 2, withdraw in epoch 3', async function () {
            await moveAtEpoch(2)
            await staking.manualEpochInit([erc20Mock.address], 0)
            await staking.manualEpochInit([erc20Mock.address], 1)

            await deposit(user, amount)

            expect(await getEpochPoolSize(3)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 3)).to.be.equal(amount.toString())

            await moveAtEpoch(3)
            await withdraw(user, amount)

            expect(await getEpochPoolSize(4)).to.be.equal('0')
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal('0')
        })

        it('multiple users deposit', async function () {
            await setNextBlockTimestamp(getCurrentUnix() + 15)
            await deposit(owner, amount)
            await deposit(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochUserBalance(ownerAddr, 1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal(amount.toString())
        })

        it('multiple users deposit epoch 0 then 1 withdraw epoch 1', async function () {
            await setNextBlockTimestamp(getCurrentUnix() + 15)
            await deposit(owner, amount)
            await deposit(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochUserBalance(ownerAddr, 1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal(amount.toString())

            await moveAtEpoch(1)
            await withdraw(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(ownerAddr, 1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal('0')
        })

        it('multiple users deposit epoch 0 then 1 withdraw epoch 2', async function () {
            await setNextBlockTimestamp(getCurrentUnix() + 15)
            await deposit(owner, amount)
            await deposit(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochUserBalance(ownerAddr, 1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal(amount.toString())

            await moveAtEpoch(2)
            await withdraw(user, amount)

            expect(await getEpochPoolSize(1)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochPoolSize(2)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(ownerAddr, 1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(ownerAddr, 2)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 1)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 2)).to.be.equal('0')
            expect(await getEpochUserBalance(userAddr, 3)).to.be.equal('0')
        })

        it('multiple deposits in same epoch', async function () {
            await moveAtEpoch(1)
            await staking.manualEpochInit([erc20Mock.address], 0)

            await deposit(user, amount)
            await deposit(user, amount)

            expect(await getEpochUserBalance(userAddr, 2)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochPoolSize(2)).to.be.equal(amount.mul(2).toString())
        })

        it('deposit epoch 2, deposit epoch 3, withdraw epoch 3', async function () {
            await moveAtEpoch(2)

            await staking.manualEpochInit([erc20Mock.address], 0)
            await staking.manualEpochInit([erc20Mock.address], 1)
            await staking.manualEpochInit([erc20Mock.address], 2)

            await deposit(user, amount)
            expect(await getEpochUserBalance(userAddr, 3)).to.be.equal(amount.toString())
            expect(await getEpochPoolSize(3)).to.be.equal(amount.toString())

            await moveAtEpoch(3)
            await deposit(user, amount)
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochPoolSize(4)).to.be.equal(amount.mul(2).toString())

            await withdraw(user, amount.mul(2))
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal('0')
            expect(await getEpochPoolSize(4)).to.be.equal('0')
        })

        it('deposit epoch 1, deposit epoch 3, withdraw epoch 3', async function () {
            await moveAtEpoch(1)
            await staking.manualEpochInit([erc20Mock.address], 0)

            await deposit(user, amount)
            expect(await getEpochUserBalance(userAddr, 2)).to.be.equal(amount.toString())
            expect(await getEpochPoolSize(2)).to.be.equal(amount.toString())

            await moveAtEpoch(3)
            await deposit(user, amount)
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal(amount.mul(2).toString())
            expect(await getEpochPoolSize(4)).to.be.equal(amount.mul(2).toString())

            await withdraw(user, amount.mul(2))
            expect(await getEpochUserBalance(userAddr, 2)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 4)).to.be.equal('0')
            expect(await getEpochPoolSize(4)).to.be.equal('0')
        })

        it('deposit epoch 1, deposit epoch 4, deposit epoch 5, withdraw epoch 5', async function () {
            await moveAtEpoch(1)
            await staking.manualEpochInit([erc20Mock.address], 0)

            await deposit(user, amount)
            expect(await getEpochUserBalance(userAddr, 2)).to.be.equal(amount.toString())
            expect(await getEpochPoolSize(2)).to.be.equal(amount.toString())

            await moveAtEpoch(4)
            await staking.manualEpochInit([erc20Mock.address], 3)

            await deposit(user, amount)

            await moveAtEpoch(5)
            await deposit(user, amount)
            expect(await getEpochUserBalance(userAddr, 2)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 3)).to.be.equal(amount.toString())
            expect(await getEpochUserBalance(userAddr, 6)).to.be.equal(amount.mul(3).toString())
            expect(await getEpochPoolSize(2)).to.be.equal(amount.toString())
            expect(await getEpochPoolSize(3)).to.be.equal(amount.toString())
            expect(await getEpochPoolSize(6)).to.be.equal(amount.mul(3).toString())

            await withdraw(user, amount.mul(3))
            expect(await getEpochPoolSize(7)).to.be.equal('0')
            expect(await getEpochUserBalance(userAddr, 7)).to.be.equal('0')
        })
    })

    describe('getEpochPoolSize', function () {
        beforeEach(async function () {
            await erc20Mock.mint(userAddr, amount.mul(10))
            await erc20Mock.connect(user).approve(staking.address, amount.mul(10))
        })

        it('Reverts if there\'s a gap', async function () {
            await moveAtEpoch(2)

            await expect(deposit(user, amount)).to.be.revertedWith('Staking: previous epoch not initialized')
        })

        it('Returns pool size when epoch is initialized', async function () {
            await moveAtEpoch(1)
            await staking.manualEpochInit([erc20Mock.address], 0)
            await deposit(user, amount)

            expect(await getEpochPoolSize(2)).to.be.equal(amount.toString())
        })

        it('Returns 0 when there was no action ever', async function () {
            expect(await getEpochPoolSize(0)).to.be.equal('0')
            expect(await getEpochPoolSize(2)).to.be.equal('0')
            expect(await getEpochPoolSize(5)).to.be.equal('0')
            expect(await getEpochPoolSize(79)).to.be.equal('0')
            expect(await getEpochPoolSize(1542)).to.be.equal('0')
        })

        it('Returns correct balance where there was an action at some point', async function () {
            await moveAtEpoch(1)
            await staking.manualEpochInit([erc20Mock.address], 0)
            await deposit(user, amount)

            expect(await getEpochPoolSize(79)).to.be.equal(amount.toString())
        })
    })

    describe('currentEpochMultiplier', function () {
        it('Returns correct value', async function () {
            // epoch size is 1 week = 604800 seconds

            await moveAtEpoch(1)

            // after 100 seconds, multiplier should be 0.9998
            await moveAtTimestamp(epoch1Start + 100)

            let expectedMultiplier = multiplierAtTs(1, await getBlockTimestamp())
            expect(await staking.currentEpochMultiplier()).to.be.equal(expectedMultiplier)

            // after 1h, multiplier should be  0.9940
            await moveAtTimestamp(epoch1Start + 3600)
            expectedMultiplier = multiplierAtTs(1, await getBlockTimestamp())
            expect(await staking.currentEpochMultiplier()).to.be.equal(expectedMultiplier)

            // after 1 day, multiplier should be 0.8571
            await moveAtTimestamp(epoch1Start + 86400)
            expectedMultiplier = multiplierAtTs(1, await getBlockTimestamp())
            expect(await staking.currentEpochMultiplier()).to.be.equal(expectedMultiplier)

            // after 3.5 days (half time; 86400 + 216000), multiplier should be 0.5
            await moveAtTimestamp(epoch1Start + 302400)
            expectedMultiplier = multiplierAtTs(1, await getBlockTimestamp())
            expect(await staking.currentEpochMultiplier()).to.be.equal(expectedMultiplier)
        })
    })

    describe('computeNewMultiplier', function () {
        it('Returns correct value', async function () {
            // 0.75 with 18 decimals
            const expectedMultiplier = scaleMultiplier(0.75, 2)

            expect(
                await staking.computeNewMultiplier(1000, BASE_MULTIPLIER, 1000, BASE_MULTIPLIER.div(2)),
            ).to.equal(BN.from(expectedMultiplier))
        })
    })

    describe('emergencyWithdraw', function () {
        beforeEach(async function () {
            await erc20Mock.mint(userAddr, amount.mul(10))
            await erc20Mock.mint(ownerAddr, amount.mul(10))
            await erc20Mock.connect(user).approve(staking.address, amount.mul(10))
            await erc20Mock.connect(owner).approve(staking.address, amount.mul(10))
        })

        it('Does not work if less than 10 epochs passed', async function () {
            await expect(
                staking.connect(user).emergencyWithdraw(erc20Mock.address),
            ).to.be.revertedWith('At least 10 epochs must pass without success')
        })

        it('Reverts if user has no balance', async function () {
            await moveAtEpoch(11)

            await expect(
                staking.connect(user).emergencyWithdraw(erc20Mock.address),
            ).to.be.revertedWith('Amount must be > 0')
        })

        it('Reverts if user has balance but less than 10 epochs passed', async function () {
            await deposit(user, amount)

            await expect(
                staking.connect(user).emergencyWithdraw(erc20Mock.address),
            ).to.be.revertedWith('At least 10 epochs must pass without success')
        })

        it('Reverts if user has balance, more than 10 epochs passed but somebody else did a withdraw',
            async function () {
                await deposit(user, amount)
                await deposit(owner, amount)

                await moveAtEpoch(5)
                await staking.manualEpochInit([erc20Mock.address], 2)
                await staking.manualEpochInit([erc20Mock.address], 3)
                await staking.manualEpochInit([erc20Mock.address], 4)

                await withdraw(owner, amount)

                await moveAtEpoch(11)

                await expect(
                    staking.connect(user).emergencyWithdraw(erc20Mock.address),
                ).to.be.revertedWith('At least 10 epochs must pass without success')
            },
        )

        it('Works if more than 10 epochs passed with no withdraw', async function () {
            await deposit(user, amount)
            await moveAtEpoch(11)

            await expect(
                staking.connect(user).emergencyWithdraw(erc20Mock.address),
            ).to.not.be.reverted

            expect(await erc20Mock.transferCalled()).to.be.true
            expect(await erc20Mock.transferRecipient()).to.be.equal(userAddr)
            expect((await erc20Mock.transferAmount()).toString()).to.be.equal(amount.toString())
            expect(await staking.balanceOf(userAddr, erc20Mock.address)).to.be.equal(0)
        })
    })

    describe('Events', function () {
        beforeEach(async function () {
            await erc20Mock.mint(userAddr, amount.mul(10))
            await erc20Mock.connect(user).approve(staking.address, amount.mul(10))
        })

        it('Deposit emits Deposit event', async function () {
            await expect(staking.connect(user).deposit(erc20Mock.address, 10))
                .to.emit(staking, 'Deposit')
        })

        it('Withdraw emits Withdraw event', async function () {
            await deposit(user, amount)

            await expect(staking.connect(user).withdraw(erc20Mock.address, 10))
                .to.emit(staking, 'Withdraw')
        })

        it('ManualEpochInit emits ManualEpochInit event', async function () {
            await moveAtEpoch(1)
            await expect(staking.manualEpochInit([erc20Mock.address], 0))
                .to.emit(staking, 'ManualEpochInit')
        })

        it('EmergencyWithdraw emits EmergencyWithdraw event', async function () {
            await deposit(user, amount)

            await moveAtEpoch(20)

            await expect(staking.connect(user).emergencyWithdraw(erc20Mock.address))
                .to.emit(staking, 'EmergencyWithdraw')
        })
    })

    async function getBlockTimestamp () {
        const block = await ethers.provider.send('eth_getBlockByNumber', ['latest', false])

        return parseInt(block.timestamp)
    }

    function computeEffectiveBalance (balance, multiplier) {
        return balance.mul(multiplier).div(BASE_MULTIPLIER)
    }

    function multiplierAtTs (epoch, ts) {
        const epochEnd = epoch1Start + epoch * epochDuration
        const timeLeft = epochEnd - ts

        return BN.from(timeLeft).mul(BASE_MULTIPLIER).div(epochDuration)
    }

    function scaleMultiplier (floatValue, currentDecimals) {
        const value = floatValue * Math.pow(10, currentDecimals)

        return BN.from(value).mul(BN.from(10).pow(MULTIPLIER_DECIMALS - currentDecimals))
    }

    function calculateMultiplier (previousBalance, previousMultiplier, newDeposit, newMultiplier) {
        const pb = BN.from(previousBalance)
        const pm = BN.from(previousMultiplier)
        const nd = BN.from(newDeposit)
        const nm = BN.from(newMultiplier)

        const pa = pb.mul(pm).div(BASE_MULTIPLIER)
        const na = nd.mul(nm).div(BASE_MULTIPLIER)

        return pa.add(na).mul(BASE_MULTIPLIER).div(pb.add(nd))
    }

    function getEpochStart (epoch) {
        return epoch1Start + (epoch - 1) * epochDuration
    }

    async function deposit (u, x) {
        return await staking.connect(u).deposit(erc20Mock.address, x)
    }

    async function withdraw (u, x) {
        return await staking.connect(u).withdraw(erc20Mock.address, x)
    }

    async function getEpochPoolSize (epochId) {
        return (await staking.getEpochPoolSize(erc20Mock.address, epochId)).toString()
    }

    async function getEpochUserBalance (u, epochId) {
        return (await staking.getEpochUserBalance(u, erc20Mock.address, epochId)).toString()
    }

    // eslint-disable-next-line no-unused-vars
    async function getCurrentEpoch () {
        return (await staking.getCurrentEpoch()).toString()
    }

    // eslint-disable-next-line no-unused-vars
    async function currentBlockNumber () {
        return await ethers.provider.getBlockNumber()
    }

    function getCurrentUnix () {
        return Math.floor(Date.now() / 1000)
    }

    async function setNextBlockTimestamp (timestamp) {
        const block = await ethers.provider.send('eth_getBlockByNumber', ['latest', false])
        const currentTs = parseInt(block.timestamp)
        const diff = timestamp - currentTs
        await ethers.provider.send('evm_increaseTime', [diff])
    }

    async function moveAtEpoch (epoch) {
        await setNextBlockTimestamp(epoch1Start + epochDuration * (epoch - 1))
        await ethers.provider.send('evm_mine')
    }

    async function moveAtTimestamp (timestamp) {
        await setNextBlockTimestamp(timestamp)
        await ethers.provider.send('evm_mine')
    }
})
