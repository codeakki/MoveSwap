import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button.jsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx'
import { Input } from '@/components/ui/input.jsx'
import { Label } from '@/components/ui/label.jsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx'
import { Progress } from '@/components/ui/progress.jsx'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.jsx'
import { ArrowRightLeft, Wallet, Clock, CheckCircle } from 'lucide-react'
import './App.css'

function App() {
  const [sourceChain, setSourceChain] = useState('ethereum')
  const [destChain, setDestChain] = useState('sui')
  const [amount, setAmount] = useState('')
  const [swapStatus, setSwapStatus] = useState('idle') // idle, creating, pending, completed, failed
  const [swapProgress, setSwapProgress] = useState(0)
  const [currentStep, setCurrentStep] = useState(0)
  const [estimatedOutput, setEstimatedOutput] = useState('')

  const chains = [
    { id: 'ethereum', name: 'Ethereum', icon: '⟠' },
    { id: 'sui', name: 'Sui', icon: '🌊' }
  ]


  const swapSteps = [
    { title: 'Create Order', description: 'Generate hashlock and create cross-chain order' },
    { title: 'Lock Funds', description: 'Lock tokens in HTLC on source chain' },
    { title: 'Resolver Fill', description: 'Resolver fills order on destination chain' },
    { title: 'Reveal Secret', description: 'Complete swap by revealing secret' },
    { title: 'Claim Funds', description: 'Receive tokens on destination chain' }
  ]

  useEffect(() => {
    if (amount) {
      // Simulate price calculation - ETH to SUI rate
      const rate = 0.5 // 1 ETH = 0.5 SUI (example rate)
      setEstimatedOutput((parseFloat(amount) * rate).toFixed(6))
    }
  }, [amount])


  const simulateSwap = async () => {
    setSwapStatus('creating')
    setCurrentStep(0)
    setSwapProgress(0)
    
    // Simulate swap process
    for (let i = 0; i < swapSteps.length; i++) {
      setCurrentStep(i)
      setSwapProgress((i / (swapSteps.length - 1)) * 100)
      
      // Simulate different step durations
      const delay = i === 2 ? 3000 : 1500 // Resolver step takes longer
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    
    setSwapStatus('completed')
    setSwapProgress(100)
  }

  const resetSwap = () => {
    setSwapStatus('idle')
    setSwapProgress(0)
    setCurrentStep(0)
  }

  const swapChains = () => {
    const tempChain = sourceChain
    setSourceChain(destChain)
    setDestChain(tempChain)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4 flex items-center justify-center">
      <div className="w-full max-w-none">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
              {/* Swap Interface */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ArrowRightLeft className="w-5 h-5" />
                    Cross-Chain Swap
                  </CardTitle>
                  <CardDescription>
                    Swap tokens between Ethereum and Sui using atomic swaps
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Source Chain */}
                  <div className="space-y-2">
                    <Label>From</Label>
                    <div className="flex gap-2">
                      <Select value={sourceChain} onValueChange={setSourceChain}>
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {chains.map(chain => (
                            <SelectItem key={chain.id} value={chain.id}>
                              {chain.icon} {chain.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="flex-1 flex items-center justify-center px-3 py-2 border border-input bg-background rounded-md text-sm">
                        {sourceChain === 'ethereum' ? 'ETH' : 'SUI'}
                      </div>
                    </div>
                    <Input
                      type="number"
                      placeholder="Amount"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>

                  {/* Swap Button */}
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={swapChains}
                      className="rounded-full"
                    >
                      <ArrowRightLeft className="w-4 h-4" />
                    </Button>
                  </div>

                  {/* Destination Chain */}
                  <div className="space-y-2">
                    <Label>To</Label>
                    <div className="flex gap-2">
                      <Select value={destChain} onValueChange={setDestChain}>
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {chains.map(chain => (
                            <SelectItem key={chain.id} value={chain.id}>
                              {chain.icon} {chain.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="flex-1 flex items-center justify-center px-3 py-2 border border-input bg-background rounded-md text-sm">
                        {destChain === 'ethereum' ? 'ETH' : 'SUI'}
                      </div>
                    </div>
                    <Input
                      type="text"
                      placeholder="Estimated output"
                      value={estimatedOutput}
                      readOnly
                      className="bg-gray-50 dark:bg-gray-800"
                    />
                  </div>

                  {/* Swap Button */}
                  <Button
                    onClick={simulateSwap}
                    disabled={!amount || swapStatus !== 'idle'}
                    className="w-full"
                    size="lg"
                  >
                    {swapStatus === 'idle' ? (
                      <>
                        <Wallet className="w-4 h-4 mr-2" />
                        Start Cross-Chain Swap
                      </>
                    ) : (
                      'Swap in Progress...'
                    )}
                  </Button>

                  {swapStatus !== 'idle' && (
                    <Button
                      onClick={resetSwap}
                      variant="outline"
                      className="w-full"
                    >
                      Reset Demo
                    </Button>
                  )}
                </CardContent>
              </Card>

              {/* Swap Progress */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="w-5 h-5" />
                    Swap Progress
                  </CardTitle>
                  <CardDescription>
                    Real-time status of your cross-chain atomic swap
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {swapStatus !== 'idle' && (
                    <>
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span>Progress</span>
                          <span>{Math.round(swapProgress)}%</span>
                        </div>
                        <Progress value={swapProgress} className="w-full" />
                      </div>

                      <div className="space-y-3">
                        {swapSteps.map((step, index) => (
                          <div
                            key={index}
                            className={`flex items-center gap-3 p-3 rounded-lg border ${
                              index < currentStep
                                ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
                                : index === currentStep
                                ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800'
                                : 'bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-700'
                            }`}
                          >
                            {index < currentStep ? (
                              <CheckCircle className="w-5 h-5 text-green-600" />
                            ) : index === currentStep ? (
                              <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <div className="w-5 h-5 border-2 border-gray-300 rounded-full" />
                            )}
                            <div>
                              <div className="font-medium text-sm">{step.title}</div>
                              <div className="text-xs text-gray-600 dark:text-gray-400">
                                {step.description}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {swapStatus === 'idle' && (
                    <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                      <Clock className="w-12 h-12 mx-auto mb-2 opacity-50" />
                      <p>Start a swap to see progress</p>
                    </div>
                  )}

                  {swapStatus === 'completed' && (
                    <Alert className="border-green-200 bg-green-50 dark:bg-green-900/20">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <AlertTitle className="text-green-800 dark:text-green-200">
                        Swap Completed!
                      </AlertTitle>
                      <AlertDescription className="text-green-700 dark:text-green-300">
                        Your cross-chain atomic swap has been successfully completed.
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            </div>
      </div>
    </div>
  )
}

export default App
