#pragma once
namespace boost {
  class mutex { public: void lock(){} void unlock(){} class scoped_lock{public:scoped_lock(mutex&){}};};
  template<class M> class lock_guard{public:explicit lock_guard(M&){}~lock_guard(){}};
  class thread {};
}
